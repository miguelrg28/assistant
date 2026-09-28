import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps } from '../create-app.js'
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

/** `/whatsapp`: link the owner's number through Meta Embedded Signup. Owner session (cookie) only. */
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

  return routes
}
