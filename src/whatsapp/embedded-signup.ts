import { randomInt } from 'node:crypto'
import { sql } from 'kysely'
import type { DB } from '../db/client.js'
import type { Env, MetaSignupConfig } from '../env.js'
import { decrypt, encrypt, parseKey } from './crypto.js'

// Links the owner's number through Meta Embedded Signup (Coexistence): the browser gets a short-lived
// `code` from FB.login, and this module trades it for a token, points the WABA's webhooks here,
// stores the token encrypted and asks Meta for the one-time contacts + history sync.
// Nothing here sends WhatsApp messages.

/** Popup event for "connect an existing WhatsApp Business app number". The number stays on the phone. */
export const COEXISTENCE_EVENT = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'

export type SignupEnv = Pick<Env, 'BASE_URL' | 'META_APP_SECRET' | 'META_VERIFY_TOKEN'>

export interface LinkRequest {
  code: string
  wabaId: string
  phoneNumberId: string
  /** The WA_EMBEDDED_SIGNUP event the popup reported (FINISH, FINISH_ONLY_WABA, …). */
  event: string
}

export class SignupError extends Error {}

export const SYNC_TYPES = ['smb_app_state_sync', 'history'] as const

const graph = (config: MetaSignupConfig, path: string) => `https://graph.facebook.com/${config.graphVersion}/${path}`

async function graphError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: number } } | null
  const message = body?.error?.message ?? `HTTP ${res.status}`
  return body?.error?.code ? `${message} (#${body.error.code})` : message
}

/** True when the page has everything it needs to open the Embedded Signup popup. */
export function signupReady(config: MetaSignupConfig): boolean {
  return Boolean(config.appId && config.configId && config.tokenKey)
}

async function exchangeCode(env: SignupEnv, config: MetaSignupConfig, code: string): Promise<string> {
  const url = new URL(graph(config, 'oauth/access_token'))
  url.searchParams.set('client_id', config.appId!)
  url.searchParams.set('client_secret', env.META_APP_SECRET)
  url.searchParams.set('code', code)
  const res = await fetch(url)
  if (!res.ok) throw new SignupError(`Meta rechazó el código de autorización: ${await graphError(res)}`)
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new SignupError('Meta no devolvió un access token')
  return body.access_token
}

/** Subscribes the app to the WABA, with this deployment's webhook as the callback. */
async function subscribeApp(env: SignupEnv, config: MetaSignupConfig, wabaId: string, token: string): Promise<void> {
  const body = new URLSearchParams({
    override_callback_uri: `${env.BASE_URL}/webhooks/whatsapp`,
    verify_token: env.META_VERIFY_TOKEN,
  })
  const res = await fetch(graph(config, `${encodeURIComponent(wabaId)}/subscribed_apps`), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new SignupError(`No se pudo suscribir la app a la cuenta de WhatsApp: ${await graphError(res)}`)
}

async function isRegistered(config: MetaSignupConfig, phoneNumberId: string, token: string): Promise<boolean> {
  const res = await fetch(graph(config, `${encodeURIComponent(phoneNumberId)}?fields=platform_type`), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return false
  const body = (await res.json().catch(() => ({}))) as { platform_type?: string }
  return body.platform_type === 'CLOUD_API'
}

async function registerNumber(config: MetaSignupConfig, phoneNumberId: string, token: string): Promise<void> {
  const res = await fetch(graph(config, `${encodeURIComponent(phoneNumberId)}/register`), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin: String(randomInt(100000, 1000000)) }),
  })
  if (res.ok) return
  const body = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null
  // 133005: the number already has a two-step PIN, so it's registered.
  if (body?.error?.code === 133005) return
  throw new SignupError(`No se pudo registrar el número: ${body?.error?.message ?? `HTTP ${res.status}`}`)
}

async function fetchDisplayNumber(config: MetaSignupConfig, phoneNumberId: string, token: string): Promise<string> {
  const res = await fetch(graph(config, `${encodeURIComponent(phoneNumberId)}?fields=display_phone_number`), {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) return ''
  const body = (await res.json().catch(() => ({}))) as { display_phone_number?: string }
  return body.display_phone_number ?? ''
}

/**
 * Asks Meta to start the one-time contacts and history sync. Results arrive later as
 * `smb_app_state_sync` and `history` webhooks.
 */
export async function requestSync(
  config: Pick<MetaSignupConfig, 'graphVersion'>,
  phoneNumberId: string,
  token: string,
): Promise<{ syncType: (typeof SYNC_TYPES)[number]; ok: boolean; status: number; body: string }[]> {
  const results = []
  for (const syncType of SYNC_TYPES) {
    const res = await fetch(`https://graph.facebook.com/${config.graphVersion}/${encodeURIComponent(phoneNumberId)}/smb_app_data`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
    })
    results.push({ syncType, ok: res.ok, status: res.status, body: await res.text() })
  }
  return results
}

export async function linkAccount(
  db: DB,
  env: SignupEnv,
  config: MetaSignupConfig,
  request: LinkRequest,
): Promise<{ displayPhoneNumber: string }> {
  if (!config.appId) throw new SignupError('Falta META_APP_ID')
  if (!config.tokenKey) throw new SignupError('Falta WHATSAPP_TOKEN_KEY para guardar el token cifrado')
  let key: Buffer
  try {
    key = parseKey(config.tokenKey)
  } catch (error) {
    throw new SignupError(error instanceof Error ? error.message : 'WHATSAPP_TOKEN_KEY inválida')
  }

  const token = await exchangeCode(env, config, request.code)
  await subscribeApp(env, config, request.wabaId, token)
  // Coexistence numbers stay on the WhatsApp Business app; only a plain Cloud API number needs /register.
  if (request.event !== COEXISTENCE_EVENT && !(await isRegistered(config, request.phoneNumberId, token))) {
    await registerNumber(config, request.phoneNumberId, token)
  }
  const displayPhoneNumber = await fetchDisplayNumber(config, request.phoneNumberId, token)

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('whatsapp_account').execute()
    await trx
      .insertInto('whatsapp_account')
      .values({
        waba_id: request.wabaId,
        phone_number_id: request.phoneNumberId,
        display_phone_number: displayPhoneNumber,
        token_encrypted: JSON.stringify(encrypt(token, key)),
      })
      .execute()
  })
  return { displayPhoneNumber }
}

/** The linked number's credentials, or null when nothing is linked or the key can't decrypt it. */
export async function linkedCredentials(
  db: DB,
  config: Pick<MetaSignupConfig, 'tokenKey'>,
): Promise<{ phoneNumberId: string; token: string } | null> {
  const row = await db.selectFrom('whatsapp_account').select(['phone_number_id', 'token_encrypted']).executeTakeFirst()
  if (!row || !config.tokenKey) return null
  try {
    return { phoneNumberId: row.phone_number_id, token: decrypt(row.token_encrypted, parseKey(config.tokenKey)) }
  } catch {
    return null
  }
}

/** Requests the sync for the linked number and records the outcome on the account row. */
export async function syncLinkedAccount(db: DB, config: MetaSignupConfig): Promise<{ ok: boolean; message?: string }> {
  const credentials = await linkedCredentials(db, config)
  if (!credentials) return { ok: false, message: 'No hay un número vinculado' }
  const results = await requestSync(config, credentials.phoneNumberId, credentials.token)
  const failed = results.filter((result) => !result.ok)
  if (failed.length === 0) {
    await db
      .updateTable('whatsapp_account')
      .set({ history_sync_requested_at: sql`now()`, status: 'linked', last_error: null, last_error_at: null })
      .execute()
    return { ok: true }
  }
  const message = `Falló la sincronización: ${failed.map((f) => `${f.syncType} HTTP ${f.status} ${f.body}`).join('; ')}`
  await db.updateTable('whatsapp_account').set({ status: 'error', last_error: message, last_error_at: sql`now()` }).execute()
  return { ok: false, message }
}

export async function accountStatus(db: DB) {
  const row = await db
    .selectFrom('whatsapp_account')
    .select(['waba_id', 'phone_number_id', 'display_phone_number', 'status', 'last_error', 'linked_at', 'history_sync_requested_at'])
    .executeTakeFirst()
  if (!row) return { linked: false as const }
  return {
    linked: true as const,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    displayPhoneNumber: row.display_phone_number,
    status: row.status,
    lastError: row.last_error,
    linkedAt: row.linked_at,
    historySyncRequestedAt: row.history_sync_requested_at,
  }
}

/**
 * Forgets the linked number locally. Like villalubri, it doesn't unsubscribe the WABA or revoke the
 * token at Meta; do that from Meta Business Suite if you want webhooks to stop.
 */
export async function unlinkAccount(db: DB): Promise<void> {
  await db.deleteFrom('whatsapp_account').execute()
}
