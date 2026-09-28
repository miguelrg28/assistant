import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../create-app.js'
import {
  excludeContact,
  getRetentionMonths,
  includeContact,
  listExcluded,
  purgeExpired,
  RETENTION_OPTIONS,
  retentionCutoff,
  setRetentionMonths,
} from '../data-controls.js'
import { findContacts } from '../mcp/queries.js'
import type { MetaSignupConfig } from '../env.js'
import {
  accountStatus,
  linkAccount,
  signupReady,
  SignupError,
  syncLinkedAccount,
  unlinkAccount,
} from '../whatsapp/embedded-signup.js'
import { whatsappPage } from '../whatsapp/pages.js'

const LinkBody = z.object({
  code: z.string().min(1),
  wabaId: z.string().regex(/^\d+$/),
  phoneNumberId: z.string().regex(/^\d+$/),
  event: z.string().max(64).default('FINISH'),
})

const WaIdBody = z.object({ waId: z.string().regex(/^\d{6,20}$/) })
const RetentionBody = z.object({ months: z.union(RETENTION_OPTIONS.map((m) => z.literal(m))) })

/**
 * `/whatsapp`: link the owner's number through Meta Embedded Signup, and choose what the archive keeps
 * (excluded chats, retention). Owner session (cookie) only.
 */
export function whatsappAccountRoutes({ db, auth, env, background }: AppDeps, config: MetaSignupConfig) {
  const routes = new Hono()

  const isOwner = async (headers: Headers) => {
    const session = await auth.api.getSession({ headers })
    return session?.user.email.toLowerCase() === env.OWNER_EMAIL
  }

  routes.get('/', async (c) => {
    if (!(await isOwner(c.req.raw.headers))) return c.redirect('/login?next=/whatsapp')
    return c.html(whatsappPage())
  })

  routes.use('/api/*', async (c, next) => {
    if (!(await isOwner(c.req.raw.headers))) return c.json({ message: 'No autorizado' }, 401)
    // A JSON content type can't be sent cross-site without a CORS preflight, which we never grant.
    if (c.req.method === 'POST' && !c.req.header('content-type')?.includes('application/json')) {
      return c.json({ message: 'Se esperaba JSON' }, 415)
    }
    await next()
  })

  routes.get('/api/meta', (c) =>
    c.json({ appId: config.appId ?? null, configId: config.configId ?? null, graphVersion: config.graphVersion, ready: signupReady(config) }),
  )

  routes.get('/api/status', async (c) => c.json(await accountStatus(db)))

  routes.post('/api/link', async (c) => {
    const parsed = LinkBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ message: 'Datos de vinculación inválidos' }, 400)
    try {
      const { displayPhoneNumber } = await linkAccount(db, env, config, parsed.data)
      // Meta only accepts the sync shortly after onboarding, so ask for it now instead of by hand.
      background(
        syncLinkedAccount(db, config).catch((error: unknown) => {
          console.error('whatsapp sync request failed', { error: error instanceof Error ? error.message : 'unknown' })
        }),
      )
      return c.json({ ok: true, displayPhoneNumber })
    } catch (error) {
      if (error instanceof SignupError) return c.json({ message: error.message }, 400)
      throw error
    }
  })

  routes.post('/api/sync', async (c) => {
    const result = await syncLinkedAccount(db, config)
    return result.ok ? c.json({ ok: true }) : c.json({ message: result.message }, 400)
  })

  routes.post('/api/unlink', async (c) => {
    await unlinkAccount(db)
    return c.json({ ok: true })
  })

  // --- Privacy: excluded chats and retention ---------------------------------

  routes.get('/api/privacy', async (c) => {
    const months = await getRetentionMonths(db)
    const settings = await db.selectFrom('data_settings').select('last_purge_at').executeTakeFirst()
    return c.json({
      retentionMonths: months,
      options: RETENTION_OPTIONS,
      cutoff: retentionCutoff(months),
      lastPurgeAt: settings?.last_purge_at ?? null,
      excluded: await listExcluded(db),
    })
  })

  routes.post('/api/privacy/retention', async (c) => {
    const parsed = RetentionBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ message: 'Elige 3, 6, 9 o 12 meses' }, 400)
    await setRetentionMonths(db, parsed.data.months)
    // Apply it right away instead of waiting for the daily cron.
    const result = await purgeExpired(db)
    return c.json({ ok: true, retentionMonths: parsed.data.months, cutoff: result.cutoff, deletedMessages: result.deletedMessages })
  })

  routes.get('/api/privacy/contacts', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (q.length < 2) return c.json({ contacts: [] })
    const matches = await findContacts(db, q.slice(0, 100), 8)
    return c.json({ contacts: matches.map((m) => ({ waId: m.wa_id, name: m.name, lastMessageAt: m.last_message_at })) })
  })

  routes.post('/api/privacy/exclude', async (c) => {
    const parsed = WaIdBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ message: 'Número inválido' }, 400)
    const { waId } = parsed.data
    const contact = await db.selectFrom('contacts').select(['saved_name', 'profile_name']).where('wa_id', '=', waId).executeTakeFirst()
    const label = contact?.saved_name ?? contact?.profile_name ?? ''
    const { deletedMessages } = await excludeContact(db, waId, label)
    return c.json({ ok: true, deletedMessages })
  })

  routes.post('/api/privacy/include', async (c) => {
    const parsed = WaIdBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ message: 'Número inválido' }, 400)
    await includeContact(db, parsed.data.waId)
    return c.json({ ok: true })
  })

  return routes
}
