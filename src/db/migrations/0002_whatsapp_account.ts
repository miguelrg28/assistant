import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // One row at most: the number linked through Embedded Signup. Re-linking replaces it.
  await db.schema
    .createTable('whatsapp_account')
    .addColumn('id', 'bigserial', (col) => col.primaryKey())
    .addColumn('waba_id', 'text', (col) => col.notNull())
    .addColumn('phone_number_id', 'text', (col) => col.notNull())
    .addColumn('display_phone_number', 'text', (col) => col.notNull().defaultTo(''))
    .addColumn('token_encrypted', 'jsonb', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('linked').check(sql`status in ('linked', 'error')`))
    .addColumn('last_error', 'text')
    .addColumn('last_error_at', 'timestamptz')
    .addColumn('history_sync_requested_at', 'timestamptz')
    .addColumn('linked_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('whatsapp_account').execute()
}
