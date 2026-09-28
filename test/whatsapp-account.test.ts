import { randomBytes } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertOwner } from '../src/auth/owner.js'
import { createApp } from '../src/create-app.js'
import type { MetaSignupConfig } from '../src/env.js'
import { decrypt, encrypt, parseKey } from '../src/whatsapp/crypto.js'
import { COEXISTENCE_EVENT } from '../src/whatsapp/embedded-signup.js'
import { createTestApp, OWNER_PASSWORD, TEST_ENV } from './helpers.js'

const TOKEN_KEY = randomBytes(32).toString('base64')
const CONFIG: MetaSignupConfig = { appId: '1234', configId: '5678', graphVersion: 'v23.0', tokenKey: TOKEN_KEY }
const ACCESS_TOKEN = 'EAAG-secret-access-token'

let ctx: Awaited<ReturnType<typeof createTestApp>>
let app: ReturnType<typeof createApp>
let cookie: string

beforeAll(async () => {
  ctx = await createTestApp()
  await upsertOwner(ctx.auth, TEST_ENV.OWNER_EMAIL, OWNER_PASSWORD)
  const pending: Promise<unknown>[] = []
  app = createApp({ db: ctx.db, auth: ctx.auth, env: ctx.env, metaSignup: CONFIG, background: (task) => pending.push(task) })
  ctx.settle = async () => {
    while (pending.length) await Promise.all(pending.splice(0))
  }
  const res = await app.request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: TEST_ENV.OWNER_EMAIL, password: OWNER_PASSWORD }),
  })
  expect(res.status).toBe(200)
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
})

const get = (path: string, withCookie = true) => app.request(path, { headers: withCookie ? { cookie } : {} })
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

/** Fake Graph API: records every call, answers by path. */
function stubGraph(overrides: Record<string, () => Response> = {}) {
  const calls: { url: URL; init?: RequestInit }[] = []
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    for (const [pattern, respond] of Object.entries(overrides)) if (url.pathname.endsWith(pattern)) return respond()
    if (url.pathname.endsWith('/oauth/access_token')) return Response.json({ access_token: ACCESS_TOKEN })
    if (url.pathname.endsWith('/subscribed_apps')) return Response.json({ success: true })
    if (url.pathname.endsWith('/smb_app_data')) return Response.json({ success: true })
    if (url.pathname.endsWith('/register')) return Response.json({ success: true })
    if (url.searchParams.get('fields') === 'display_phone_number') return Response.json({ display_phone_number: '+1 555 0100' })
    if (url.searchParams.get('fields') === 'platform_type') return Response.json({ platform_type: 'NOT_APPLICABLE' })
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

beforeEach(async () => {
  await ctx.db.deleteFrom('whatsapp_account').execute()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('token encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const key = parseKey(TOKEN_KEY)
    const a = encrypt('hola', key)
    expect(decrypt(a, key)).toBe('hola')
    expect(encrypt('hola', key).iv).not.toBe(a.iv)
  })

  it('accepts hex keys and rejects the wrong length', () => {
    expect(parseKey('ab'.repeat(32))).toHaveLength(32)
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/)
  })

  it('fails to decrypt with another key', () => {
    const value = encrypt('hola', parseKey(TOKEN_KEY))
    expect(() => decrypt(value, randomBytes(32))).toThrow()
  })
})

describe('/whatsapp access', () => {
  it('redirects the page to login without a session', async () => {
    const res = await get('/whatsapp', false)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?next=/whatsapp')
  })

  it('401s the API without a session', async () => {
    expect((await get('/whatsapp/api/status', false)).status).toBe(401)
    const res = await app.request('/whatsapp/api/unlink', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(401)
  })

  it('refuses non-JSON POSTs (CSRF guard)', async () => {
    const res = await app.request('/whatsapp/api/unlink', { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' })
    expect(res.status).toBe(415)
  })

  it('serves the page to the owner with a popup-friendly COOP header', async () => {
    const res = await get('/whatsapp')
    expect(res.status).toBe(200)
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups')
    expect(await res.text()).toContain('connect.facebook.net/en_US/sdk.js')
  })

  it('keeps the strict COOP header everywhere else', async () => {
    const res = await app.request('/login')
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  })

  it('exposes the public Embedded Signup settings', async () => {
    const res = await get('/whatsapp/api/meta')
    expect(await res.json()).toEqual({ appId: '1234', configId: '5678', graphVersion: 'v23.0', ready: true })
  })
})

describe('linking', () => {
  const link = { code: 'short-lived-code', wabaId: '111', phoneNumberId: '222', event: COEXISTENCE_EVENT }

  it('exchanges the code, subscribes the WABA to this webhook, stores the token encrypted and requests the sync', async () => {
    const calls = stubGraph()
    const res = await post('/whatsapp/api/link', link)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, displayPhoneNumber: '+1 555 0100' })
    await ctx.settle()

    const exchange = calls.find((c) => c.url.pathname.endsWith('/oauth/access_token'))!
    expect(exchange.url.searchParams.get('client_id')).toBe('1234')
    expect(exchange.url.searchParams.get('client_secret')).toBe(TEST_ENV.META_APP_SECRET)
    expect(exchange.url.searchParams.get('code')).toBe('short-lived-code')

    const subscribe = calls.find((c) => c.url.pathname === '/v23.0/111/subscribed_apps')!
    const form = new URLSearchParams(String(subscribe.init?.body))
    expect(form.get('override_callback_uri')).toBe(`${TEST_ENV.BASE_URL}/webhooks/whatsapp`)
    expect(form.get('verify_token')).toBe(TEST_ENV.META_VERIFY_TOKEN)

    // Coexistence: the number stays on the phone app, so it's never registered.
    expect(calls.some((c) => c.url.pathname.endsWith('/register'))).toBe(false)

    const syncs = calls.filter((c) => c.url.pathname === '/v23.0/222/smb_app_data').map((c) => JSON.parse(String(c.init?.body)).sync_type)
    expect(syncs).toEqual(['smb_app_state_sync', 'history'])

    const row = await ctx.db.selectFrom('whatsapp_account').selectAll().executeTakeFirstOrThrow()
    expect(JSON.stringify(row.token_encrypted)).not.toContain(ACCESS_TOKEN)
    expect(decrypt(row.token_encrypted, parseKey(TOKEN_KEY))).toBe(ACCESS_TOKEN)
    expect(row.history_sync_requested_at).not.toBeNull()
  })

  it('registers a plain Cloud API number that is not registered yet', async () => {
    const calls = stubGraph()
    const res = await post('/whatsapp/api/link', { ...link, event: 'FINISH' })
    expect(res.status).toBe(200)
    expect(calls.some((c) => c.url.pathname === '/v23.0/222/register')).toBe(true)
  })

  it('replaces the previously linked number', async () => {
    stubGraph()
    await post('/whatsapp/api/link', link)
    await post('/whatsapp/api/link', { ...link, wabaId: '333', phoneNumberId: '444' })
    await ctx.settle()
    const rows = await ctx.db.selectFrom('whatsapp_account').select(['waba_id']).execute()
    expect(rows).toEqual([{ waba_id: '333' }])
  })

  it('reports Meta errors as 400 and stores nothing', async () => {
    stubGraph({ '/oauth/access_token': () => Response.json({ error: { message: 'Code expired', code: 100 } }, { status: 400 }) })
    const res = await post('/whatsapp/api/link', link)
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('Code expired')
    expect(await ctx.db.selectFrom('whatsapp_account').selectAll().execute()).toEqual([])
  })

  it('rejects malformed ids', async () => {
    stubGraph()
    const res = await post('/whatsapp/api/link', { ...link, wabaId: '../me' })
    expect(res.status).toBe(400)
  })

  it('marks the account as error when the sync request fails', async () => {
    stubGraph({ '/smb_app_data': () => Response.json({ error: { message: 'too late' } }, { status: 400 }) })
    await post('/whatsapp/api/link', link)
    await ctx.settle()
    const status = await (await get('/whatsapp/api/status')).json()
    expect(status.status).toBe('error')
    expect(status.lastError).toContain('too late')
  })
})

describe('status and unlink', () => {
  it('never returns the token and forgets the number on unlink', async () => {
    stubGraph()
    await post('/whatsapp/api/link', { code: 'c', wabaId: '111', phoneNumberId: '222', event: COEXISTENCE_EVENT })
    await ctx.settle()

    const body = await (await get('/whatsapp/api/status')).text()
    expect(body).not.toContain(ACCESS_TOKEN)
    expect(body).not.toContain('token')
    expect(JSON.parse(body)).toMatchObject({ linked: true, wabaId: '111', phoneNumberId: '222', displayPhoneNumber: '+1 555 0100', status: 'linked' })

    expect((await post('/whatsapp/api/unlink')).status).toBe(200)
    expect(await (await get('/whatsapp/api/status')).json()).toEqual({ linked: false })
  })

  it('retries the sync by hand', async () => {
    const calls = stubGraph()
    await post('/whatsapp/api/link', { code: 'c', wabaId: '111', phoneNumberId: '222', event: COEXISTENCE_EVENT })
    await ctx.settle()
    calls.length = 0
    expect((await post('/whatsapp/api/sync')).status).toBe(200)
    expect(calls.filter((c) => c.url.pathname.endsWith('/smb_app_data'))).toHaveLength(2)
  })
})
