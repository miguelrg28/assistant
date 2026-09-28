import { sql, type Kysely, type SqlBool } from 'kysely'
import type { DB } from './db/client.js'
import type { Database, RetentionMonths } from './db/schema.js'

// What the archive keeps: excluded contacts are never stored (so the AI can never read them), and
// messages older than the retention window are deleted daily and dropped when they arrive late
// (e.g. the history backfill).

export const RETENTION_OPTIONS = [3, 6, 9, 12] as const satisfies readonly RetentionMonths[]

/** Raw webhook payloads contain message bodies; once applied they're only kept this long for debugging. */
const PROCESSED_EVENTS_KEEP_DAYS = 7

type Executor = Kysely<Database>

export async function getRetentionMonths(db: Executor): Promise<RetentionMonths> {
  const row = await db.selectFrom('data_settings').select('retention_months').executeTakeFirst()
  return row?.retention_months ?? 12
}

/** Oldest `sent_at` still kept. */
export function retentionCutoff(months: RetentionMonths, now = new Date()): Date {
  const cutoff = new Date(now)
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months)
  return cutoff
}

export async function isExcluded(db: Executor, waId: string): Promise<boolean> {
  const row = await db.selectFrom('excluded_contacts').select('wa_id').where('wa_id', '=', waId).executeTakeFirst()
  return Boolean(row)
}

export async function listExcluded(db: DB) {
  const rows = await db.selectFrom('excluded_contacts').select(['wa_id', 'label', 'created_at']).orderBy('created_at', 'desc').execute()
  return rows.map((row) => ({ waId: row.wa_id, label: row.label, excludedAt: row.created_at }))
}

/** Excludes a contact and deletes everything stored about it (contact → chat → messages cascade). */
export async function excludeContact(db: DB, waId: string, label: string): Promise<{ deletedMessages: number }> {
  return db.transaction().execute(async (tx) => {
    await tx
      .insertInto('excluded_contacts')
      .values({ wa_id: waId, label })
      .onConflict((oc) => oc.column('wa_id').doUpdateSet({ label }))
      .execute()
    const counted = await tx
      .selectFrom('messages')
      .innerJoin('chats', 'chats.id', 'messages.chat_id')
      .innerJoin('contacts', 'contacts.id', 'chats.contact_id')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('contacts.wa_id', '=', waId)
      .executeTakeFirstOrThrow()
    await tx.deleteFrom('contacts').where('wa_id', '=', waId).execute()
    return { deletedMessages: Number(counted.n) }
  })
}

/** Stops excluding a contact. Only messages that arrive from now on are stored; deleted ones don't come back. */
export async function includeContact(db: DB, waId: string): Promise<void> {
  await db.deleteFrom('excluded_contacts').where('wa_id', '=', waId).execute()
}

export async function setRetentionMonths(db: DB, months: RetentionMonths): Promise<void> {
  await db.updateTable('data_settings').set({ retention_months: months }).execute()
}

/**
 * Deletes messages older than the retention window, fixes the chat markers that pointed at them,
 * removes chats left empty, and drops old processed webhook payloads.
 */
export async function purgeExpired(db: DB, now = new Date()) {
  const cutoff = retentionCutoff(await getRetentionMonths(db), now)
  const eventsCutoff = new Date(now.getTime() - PROCESSED_EVENTS_KEEP_DAYS * 86_400_000)

  return db.transaction().execute(async (tx) => {
    const messages = await tx.deleteFrom('messages').where('sent_at', '<', cutoff).executeTakeFirst()

    // Markers are maxima, so they only go stale when every message of that kind was deleted.
    for (const column of ['last_message_at', 'last_inbound_at', 'last_outbound_at'] as const) {
      await tx.updateTable('chats').set({ [column]: null }).where(column, '<', cutoff).execute()
    }
    const chats = await tx
      .deleteFrom('chats')
      .where('last_message_at', 'is', null)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('messages').select(sql`1`.as('one')).whereRef('messages.chat_id', '=', 'chats.id'))),
      )
      .executeTakeFirst()

    const events = await tx
      .deleteFrom('webhook_events')
      .where('processed_at', 'is not', null)
      .where(sql<SqlBool>`received_at < ${eventsCutoff}`)
      .executeTakeFirst()

    await tx.updateTable('data_settings').set({ last_purge_at: now }).execute()
    return {
      cutoff,
      deletedMessages: Number(messages.numDeletedRows),
      deletedChats: Number(chats.numDeletedRows),
      deletedEvents: Number(events.numDeletedRows),
    }
  })
}
