import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // Contacts whose chats are never stored (nor shown to the AI). Keyed by wa_id so the exclusion
  // outlives the contact row, which is deleted along with its messages.
  await db.schema
    .createTable('excluded_contacts')
    .addColumn('wa_id', 'text', (col) => col.primaryKey())
    /** Name shown in the settings page; the contact row itself is gone. */
    .addColumn('label', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()

  // Single-row settings table: the `id = true` check keeps it to one row.
  await db.schema
    .createTable('data_settings')
    .addColumn('id', 'boolean', (col) => col.primaryKey().defaultTo(true).check(sql`id`))
    .addColumn('retention_months', 'integer', (col) =>
      col.notNull().defaultTo(12).check(sql`retention_months in (3, 6, 9, 12)`),
    )
    .addColumn('last_purge_at', 'timestamptz')
    .execute()
  await db.insertInto('data_settings').values({ id: true }).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('data_settings').execute()
  await db.schema.dropTable('excluded_contacts').execute()
}
