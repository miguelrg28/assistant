import type { ColumnType, Generated, JSONColumnType } from 'kysely'
import type { EncryptedValue } from '../whatsapp/crypto.js'

type Timestamp = ColumnType<Date, Date | string, Date | string>
type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>

export type Direction = 'inbound' | 'outbound'
export type MessageSource = 'live' | 'history' | 'echo'

export interface MediaMeta {
  id?: string
  mime_type?: string
  sha256?: string
  filename?: string
  caption?: string
  voice?: boolean
  animated?: boolean
}

export interface ContactsTable {
  id: Generated<number>
  wa_id: string
  /** Name saved in the WhatsApp Business app address book (smb_app_state_sync). */
  saved_name: string | null
  /** Name the contact set on their own WhatsApp profile (messages webhook). */
  profile_name: string | null
  created_at: Generated<Timestamp>
  updated_at: Generated<Timestamp>
}

export interface ChatsTable {
  id: Generated<number>
  contact_id: number
  last_message_at: NullableTimestamp
  last_inbound_at: NullableTimestamp
  last_outbound_at: NullableTimestamp
  created_at: Generated<Timestamp>
}

export interface MessagesTable {
  id: Generated<number>
  wamid: string
  chat_id: number
  direction: Direction
  source: MessageSource
  type: string
  text_body: string | null
  media: JSONColumnType<MediaMeta | null, string | null, string | null>
  /** Delivery status for outbound messages (sent/delivered/read/failed/…). */
  status: string | null
  sent_at: Timestamp
  raw: JSONColumnType<object, string, string>
  created_at: Generated<Timestamp>
}

export interface WebhookEventsTable {
  id: Generated<number>
  received_at: Generated<Timestamp>
  payload: JSONColumnType<object, string, string>
  processed_at: NullableTimestamp
  attempts: Generated<number>
  last_error: string | null
}

export type AccountStatus = 'linked' | 'error'

export interface WhatsappAccountTable {
  id: Generated<number>
  waba_id: string
  phone_number_id: string
  display_phone_number: Generated<string>
  /** AES-256-GCM `{ iv, authTag, data }`; never returned by any endpoint. */
  token_encrypted: JSONColumnType<EncryptedValue, string, string>
  status: Generated<AccountStatus>
  last_error: string | null
  last_error_at: NullableTimestamp
  history_sync_requested_at: NullableTimestamp
  linked_at: Generated<Timestamp>
}

export interface Database {
  contacts: ContactsTable
  chats: ChatsTable
  messages: MessagesTable
  webhook_events: WebhookEventsTable
  whatsapp_account: WhatsappAccountTable
}
