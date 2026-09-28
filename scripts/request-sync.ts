// Asks Meta to start the contacts and history sync. Linking from /whatsapp already does this; use the
// script only to retry by hand. Read-only as far as WhatsApp goes: it sends no messages.
//
//   npm run whatsapp:sync                                         # number linked from /whatsapp
//   META_ACCESS_TOKEN=… META_PHONE_NUMBER_ID=… npm run whatsapp:sync  # or explicit credentials
//
// Meta then delivers smb_app_state_sync and history webhooks to /webhooks/whatsapp.
import './load-env.js'
import { createDb } from '../src/db/client.js'
import { readEnv, readMetaSignupConfig } from '../src/env.js'
import { linkedCredentials, requestSync } from '../src/whatsapp/embedded-signup.js'

const config = readMetaSignupConfig()

async function credentials() {
  const token = process.env.META_ACCESS_TOKEN
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID
  if (token && phoneNumberId) return { token, phoneNumberId }
  const db = createDb(readEnv(process.env, ['DATABASE_URL']).DATABASE_URL)
  try {
    return await linkedCredentials(db, config)
  } finally {
    await db.destroy()
  }
}

const creds = await credentials()
if (!creds) {
  console.error('No linked number (or WHATSAPP_TOKEN_KEY missing). Link it at /whatsapp, or set META_ACCESS_TOKEN and META_PHONE_NUMBER_ID.')
  process.exit(1)
}

for (const result of await requestSync(config, creds.phoneNumberId, creds.token)) {
  console.log(`${result.syncType}: HTTP ${result.status} ${result.body}`)
  if (!result.ok) process.exitCode = 1
}
