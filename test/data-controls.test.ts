import { sql } from 'kysely'
import { beforeEach, describe, expect, it } from 'vitest'
import { upsertOwner } from '../src/auth/owner.js'
import { excludeContact, includeContact, purgeExpired, retentionCutoff, setRetentionMonths } from '../src/data-controls.js'
import { createTestApp, fixture, OWNER_PASSWORD, postWebhook, TEST_ENV } from './helpers.js'

const MARIA = '5215512345678'
const OTHER = '5213398765432'
const NOW = new Date('2026-09-28T12:00:00Z')

let ctx: Awaited<ReturnType<typeof createTestApp>>
beforeEach(async () => {
  ctx = await createTestApp()
})

const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000)

/** A live inbound text message from `from`, sent at `at`. */
function textMessage(from: string, wamid: string, at: Date, body = 'hola') {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: '106540352242922' },
              contacts: [{ profile: { name: `Contacto ${from}` }, wa_id: from }],
              messages: [{ from, id: wamid, timestamp: String(Math.floor(at.getTime() / 1000)), type: 'text', text: { body } }],
            },
          },
        ],
      },
    ],
  })
}

async function deliver(...bodies: string[]) {
  for (const body of bodies) expect((await postWebhook(ctx.app, body)).status).toBe(200)
  await ctx.settle()
}

const wamids = async () => (await ctx.db.selectFrom('messages').select('wamid').orderBy('wamid').execute()).map((m) => m.wamid)
const contactIds = async () => (await ctx.db.selectFrom('contacts').select('wa_id').orderBy('wa_id').execute()).map((c) => c.wa_id)

describe('excluded chats', () => {
  it('deletes everything stored about the contact and reports how many messages went', async () => {
    await deliver(textMessage(MARIA, 'wamid.A', daysAgo(1)), textMessage(MARIA, 'wamid.B', daysAgo(1)), textMessage(OTHER, 'wamid.C', daysAgo(1)))
    const result = await excludeContact(ctx.db, MARIA, 'María')
    expect(result.deletedMessages).toBe(2)
    expect(await wamids()).toEqual(['wamid.C'])
    expect(await contactIds()).toEqual([OTHER])
  })

  it('drops new messages and address-book entries for an excluded contact', async () => {
    await excludeContact(ctx.db, MARIA, '')
    await deliver(textMessage(MARIA, 'wamid.A', daysAgo(1)), fixture('state-sync-contacts.json'), textMessage(OTHER, 'wamid.C', daysAgo(1)))
    expect(await wamids()).toEqual(['wamid.C'])
    expect(await contactIds()).toEqual([OTHER])
  })

  it('stores messages again after the exclusion is removed, without restoring old ones', async () => {
    await deliver(textMessage(MARIA, 'wamid.OLD', daysAgo(2)))
    await excludeContact(ctx.db, MARIA, '')
    await includeContact(ctx.db, MARIA)
    await deliver(textMessage(MARIA, 'wamid.NEW', daysAgo(1)))
    expect(await wamids()).toEqual(['wamid.NEW'])
  })
})

describe('retention', () => {
  it('defaults to 12 months', async () => {
    const row = await ctx.db.selectFrom('data_settings').selectAll().executeTakeFirstOrThrow()
    expect(row.retention_months).toBe(12)
  })

  it('rejects values other than 3, 6, 9 and 12 at the database level', async () => {
    await expect(sql`update data_settings set retention_months = 5`.execute(ctx.db)).rejects.toThrow()
  })

  it('drops messages older than the window when they arrive (history backfill)', async () => {
    await setRetentionMonths(ctx.db, 3)
    await deliver(textMessage(MARIA, 'wamid.OLD', daysAgo(120)), textMessage(MARIA, 'wamid.NEW', daysAgo(10)))
    expect(await wamids()).toEqual(['wamid.NEW'])
  })

  it('purges old messages, fixes chat markers and removes chats left empty', async () => {
    await deliver(
      textMessage(MARIA, 'wamid.M_OLD', daysAgo(200)),
      textMessage(MARIA, 'wamid.M_NEW', daysAgo(5)),
      textMessage(OTHER, 'wamid.O_OLD', daysAgo(200)),
    )
    await setRetentionMonths(ctx.db, 6)
    const result = await purgeExpired(ctx.db, NOW)

    expect(result.deletedMessages).toBe(2)
    expect(result.deletedChats).toBe(1)
    expect(result.cutoff).toEqual(retentionCutoff(6, NOW))
    expect(await wamids()).toEqual(['wamid.M_NEW'])

    const chats = await ctx.db
      .selectFrom('chats')
      .innerJoin('contacts', 'contacts.id', 'chats.contact_id')
      .select(['contacts.wa_id', 'chats.last_message_at', 'chats.last_inbound_at'])
      .execute()
    expect(chats).toHaveLength(1)
    expect(chats[0]!.wa_id).toBe(MARIA)
    expect(new Date(chats[0]!.last_inbound_at!)).toEqual(new Date(Math.floor(daysAgo(5).getTime() / 1000) * 1000))
  })

  it('clears a marker whose messages were all deleted', async () => {
    await deliver(textMessage(MARIA, 'wamid.IN_OLD', daysAgo(200)), fixture('echo-text.json'))
    await setRetentionMonths(ctx.db, 6)
    await purgeExpired(ctx.db, NOW)
    const chat = await ctx.db
      .selectFrom('chats')
      .innerJoin('contacts', 'contacts.id', 'chats.contact_id')
      .select(['chats.last_inbound_at', 'chats.last_outbound_at'])
      .where('contacts.wa_id', '=', MARIA)
      .executeTakeFirstOrThrow()
    expect(chat.last_inbound_at).toBeNull()
    expect(chat.last_outbound_at).not.toBeNull()
  })

  it('deletes processed webhook payloads after a week but keeps pending ones', async () => {
    await deliver(textMessage(MARIA, 'wamid.A', daysAgo(1)))
    await ctx.db.insertInto('webhook_events').values({ payload: '{}' }).execute()
    await ctx.db.updateTable('webhook_events').set({ received_at: sql`${daysAgo(8)}` }).execute()
    const result = await purgeExpired(ctx.db, NOW)
    expect(result.deletedEvents).toBe(1)
    const left = await ctx.db.selectFrom('webhook_events').select('processed_at').execute()
    expect(left).toEqual([{ processed_at: null }])
  })
})

describe('/whatsapp privacy API', () => {
  let cookie: string
  beforeEach(async () => {
    await upsertOwner(ctx.auth, TEST_ENV.OWNER_EMAIL, OWNER_PASSWORD)
    const res = await ctx.app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: TEST_ENV.OWNER_EMAIL, password: OWNER_PASSWORD }),
    })
    cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  })

  const get = (path: string) => ctx.app.request(path, { headers: { cookie } })
  const post = (path: string, body: unknown) =>
    ctx.app.request(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('requires the owner session', async () => {
    expect((await ctx.app.request('/whatsapp/api/privacy')).status).toBe(401)
  })

  it('changes the retention only to an allowed value and purges right away', async () => {
    await deliver(textMessage(MARIA, 'wamid.OLD', daysAgo(120)), textMessage(MARIA, 'wamid.NEW', daysAgo(10)))
    expect((await post('/whatsapp/api/privacy/retention', { months: 5 })).status).toBe(400)
    const res = await post('/whatsapp/api/privacy/retention', { months: 3 })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, retentionMonths: 3, deletedMessages: 1 })
    expect((await (await get('/whatsapp/api/privacy')).json()).retentionMonths).toBe(3)
  })

  it('searches contacts, excludes one with its saved name, and lists it', async () => {
    await deliver(fixture('state-sync-contacts.json'), textMessage(MARIA, 'wamid.A', daysAgo(1)))
    const search = await (await get('/whatsapp/api/privacy/contacts?q=5512345678')).json()
    expect(search.contacts[0].waId).toBe(MARIA)

    const res = await post('/whatsapp/api/privacy/exclude', { waId: MARIA })
    expect(await res.json()).toEqual({ ok: true, deletedMessages: 1 })

    const privacy = await (await get('/whatsapp/api/privacy')).json()
    expect(privacy.excluded).toHaveLength(1)
    expect(privacy.excluded[0].waId).toBe(MARIA)
    expect(privacy.excluded[0].label).not.toBe('')

    expect((await post('/whatsapp/api/privacy/include', { waId: MARIA })).status).toBe(200)
    expect((await (await get('/whatsapp/api/privacy')).json()).excluded).toEqual([])
  })

  it('can exclude a number that has never written', async () => {
    const res = await post('/whatsapp/api/privacy/exclude', { waId: '5219990001111' })
    expect(await res.json()).toEqual({ ok: true, deletedMessages: 0 })
    expect((await post('/whatsapp/api/privacy/exclude', { waId: 'abc' })).status).toBe(400)
  })
})

describe('/cron/purge', () => {
  it('needs the cron secret', async () => {
    expect((await ctx.app.request('/cron/purge')).status).toBe(401)
    const res = await ctx.app.request('/cron/purge', { headers: { authorization: `Bearer ${TEST_ENV.CRON_SECRET}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ deletedMessages: 0 })
  })
})
