import { sql, type Transaction } from 'kysely'
import { getRetentionMonths, isExcluded, retentionCutoff } from '../data-controls.js'
import type { DB } from '../db/client.js'
import type { Database } from '../db/schema.js'
import { normalizeWebhook, type ContactEvent, type MessageEvent, type StatusEvent } from '../whatsapp/normalize.js'

const MAX_ATTEMPTS = 5
const STATUS_ORDER = ['sent', 'delivered', 'read', 'played']

type Tx = Transaction<Database>

/**
 * Applies one stored webhook event. Safe to call concurrently and repeatedly:
 * the row lock skips events another worker holds, and every write is an idempotent upsert.
 */
export async function processEvent(db: DB, eventId: number): Promise<'processed' | 'skipped'> {
  try {
    return await db.transaction().execute(async (tx) => {
      const event = await tx
        .selectFrom('webhook_events')
        .select(['id', 'payload'])
        .where('id', '=', eventId)
        .where('processed_at', 'is', null)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst()
      if (!event) return 'skipped'

      const cutoff = retentionCutoff(await getRetentionMonths(tx))
      for (const item of normalizeWebhook(event.payload)) {
        if (item.kind === 'message') await applyMessage(tx, item, cutoff)
        else if (item.kind === 'status') await applyStatus(tx, item)
        else await applyContact(tx, item)
      }

      await tx.updateTable('webhook_events').set({ processed_at: new Date(), last_error: null }).where('id', '=', eventId).execute()
      return 'processed'
    })
  } catch (error) {
    await db
      .updateTable('webhook_events')
      .set((eb) => ({
        attempts: eb('attempts', '+', 1),
        last_error: error instanceof Error ? error.message.slice(0, 500) : 'unknown error',
      }))
      .where('id', '=', eventId)
      .execute()
    throw error
  }
}

/** Processes unprocessed events oldest-first until none are left or the time budget runs out. */
export async function drainPendingEvents(db: DB, { budgetMs = 45_000, batchSize = 25 } = {}) {
  const deadline = Date.now() + budgetMs
  let processed = 0
  let failed = 0
  const tried = new Set<number>()

  while (Date.now() < deadline) {
    const pending = await db
      .selectFrom('webhook_events')
      .select('id')
      .where('processed_at', 'is', null)
      .where('attempts', '<', MAX_ATTEMPTS)
      .$if(tried.size > 0, (qb) => qb.where('id', 'not in', [...tried]))
      .orderBy('id')
      .limit(batchSize)
      .execute()
    if (pending.length === 0) break

    for (const { id } of pending) {
      if (Date.now() >= deadline) break
      tried.add(id)
      try {
        if ((await processEvent(db, id)) === 'processed') processed++
      } catch {
        failed++
      }
    }
  }

  return { processed, failed }
}

async function upsertContact(tx: Tx, waId: string, profileName: string | null): Promise<number> {
  const row = await tx
    .insertInto('contacts')
    .values({ wa_id: waId, profile_name: profileName })
    .onConflict((oc) =>
      oc.column('wa_id').doUpdateSet({
        profile_name: sql`coalesce(excluded.profile_name, contacts.profile_name)`,
        updated_at: sql`now()`,
      }),
    )
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}

async function upsertChat(tx: Tx, contactId: number): Promise<number> {
  await tx.insertInto('chats').values({ contact_id: contactId }).onConflict((oc) => oc.column('contact_id').doNothing()).execute()
  const chat = await tx.selectFrom('chats').select('id').where('contact_id', '=', contactId).executeTakeFirstOrThrow()
  return chat.id
}

async function applyMessage(tx: Tx, event: MessageEvent, cutoff: Date): Promise<void> {
  // Excluded contacts are never stored, and history older than the retention window is dropped.
  if (event.sentAt < cutoff || (await isExcluded(tx, event.contactWaId))) return
  const contactId = await upsertContact(tx, event.contactWaId, event.contactProfileName)
  const chatId = await upsertChat(tx, contactId)

  const inserted = await tx
    .insertInto('messages')
    .values({
      wamid: event.wamid,
      chat_id: chatId,
      direction: event.direction,
      source: event.source,
      type: event.type,
      text_body: event.text,
      media: event.media ? JSON.stringify(event.media) : null,
      status: event.status,
      sent_at: event.sentAt,
      raw: JSON.stringify(event.raw),
    })
    // Idempotent on wamid: retries, duplicate deliveries and history overlapping live traffic are no-ops.
    .onConflict((oc) => oc.column('wamid').doNothing())
    .returning('id')
    .executeTakeFirst()
  if (!inserted || !event.countsAsActivity) return

  // greatest() ignores NULLs and never moves backwards, so arrival order doesn't matter.
  const column = event.direction === 'inbound' ? 'last_inbound_at' : 'last_outbound_at'
  await tx
    .updateTable('chats')
    .set({
      last_message_at: sql`greatest(last_message_at, ${event.sentAt})`,
      [column]: sql`greatest(${sql.ref(column)}, ${event.sentAt})`,
    })
    .where('id', '=', chatId)
    .execute()
}

async function applyStatus(tx: Tx, event: StatusEvent): Promise<void> {
  // Statuses can arrive out of order; only move forward (failed always wins).
  await tx
    .updateTable('messages')
    .set({ status: event.status })
    .where('wamid', '=', event.wamid)
    .where((eb) =>
      eb.or([
        eb('status', 'is', null),
        eb.lit(event.status === 'failed'),
        sql<boolean>`coalesce(array_position(${sql.val(STATUS_ORDER)}::text[], status), 0) < coalesce(array_position(${sql.val(STATUS_ORDER)}::text[], ${event.status}::text), 0)`,
      ]),
    )
    .execute()
}

async function applyContact(tx: Tx, event: ContactEvent): Promise<void> {
  if (await isExcluded(tx, event.waId)) return
  if (event.action === 'remove') {
    // Keep the conversation; just forget the address-book name.
    await tx.updateTable('contacts').set({ saved_name: null, updated_at: sql`now()` }).where('wa_id', '=', event.waId).execute()
    return
  }
  await tx
    .insertInto('contacts')
    .values({ wa_id: event.waId, saved_name: event.name })
    .onConflict((oc) => oc.column('wa_id').doUpdateSet({ saved_name: sql`excluded.saved_name`, updated_at: sql`now()` }))
    .execute()
}
