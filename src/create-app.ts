import { requireMcpAuth } from '@better-auth/mcp'
import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { sql } from 'kysely'
import { AUTH_BASE_PATH, CONSENT_PATH, LOGIN_PATH, mcpResourceUrl, type Auth } from './auth/auth.js'
import { consentPage, loginPage } from './auth/pages.js'
import type { DB } from './db/client.js'
import { readMetaSignupConfig, type Env, type MetaSignupConfig } from './env.js'
import { purgeExpired } from './data-controls.js'
import { drainPendingEvents } from './ingest/processor.js'
import { createMcpServer } from './mcp/server.js'
import { webhookRoutes } from './routes/webhook.js'
import { whatsappAccountRoutes } from './routes/whatsapp-account.js'
import { privacyPage } from './privacy.js'
import { safeEqual } from './whatsapp/signature.js'

export interface AppDeps {
  db: DB
  auth: Auth
  env: Env
  /** Runs work after the response is sent (Vercel `waitUntil`). Tests await it directly. */
  background: (task: Promise<unknown>) => void
  /** Embedded Signup settings for /whatsapp; read from process.env when omitted. */
  metaSignup?: MetaSignupConfig
}

export function createApp(deps: AppDeps) {
  const { db, auth, env } = deps
  const app = new Hono()

  // Registered before secureHeaders so it runs last: FB.login's popup needs `window.opener`, which
  // the default `Cross-Origin-Opener-Policy: same-origin` severs.
  app.use('/whatsapp', async (c, next) => {
    await next()
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  })
  app.use(secureHeaders())

  app.get('/', (c) => c.text('ok'))
  app.get('/privacy', (c) => c.html(privacyPage('2026-09-28')))

  // --- OAuth (Better Auth) -------------------------------------------------
  // This server protects exactly one resource, so a client that omits RFC 8707 `resource`
  // still gets a token bound to /mcp instead of an unusable one.
  const resource = mcpResourceUrl(env)
  app.get(`${AUTH_BASE_PATH}/oauth2/authorize`, (c) => {
    const url = new URL(c.req.url)
    if (url.searchParams.has('resource')) return auth.handler(c.req.raw)
    url.searchParams.set('resource', resource)
    return auth.handler(new Request(url, c.req.raw))
  })
  app.post(`${AUTH_BASE_PATH}/oauth2/token`, async (c) => {
    if (!c.req.header('content-type')?.includes('application/x-www-form-urlencoded')) return auth.handler(c.req.raw)
    const form = new URLSearchParams(await c.req.text())
    if (!form.has('resource')) form.set('resource', resource)
    return auth.handler(new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body: form }))
  })
  app.on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) => auth.handler(c.req.raw))
  // RFC 9728 protected-resource metadata; the mcp() plugin answers these paths.
  app.get('/.well-known/oauth-protected-resource', (c) => auth.handler(c.req.raw))
  app.get('/.well-known/oauth-protected-resource/*', (c) => auth.handler(c.req.raw))
  // RFC 8414 / OIDC discovery for an issuer that lives under /api/auth.
  const authServerMetadata = oauthProviderAuthServerMetadata(auth)
  const openIdMetadata = oauthProviderOpenIdConfigMetadata(auth)
  app.get(`/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`, (c) => authServerMetadata(c.req.raw))
  app.get('/.well-known/oauth-authorization-server', (c) => authServerMetadata(c.req.raw))
  app.get(`/.well-known/openid-configuration${AUTH_BASE_PATH}`, (c) => openIdMetadata(c.req.raw))
  app.get(`${AUTH_BASE_PATH}/.well-known/openid-configuration`, (c) => openIdMetadata(c.req.raw))

  app.get(LOGIN_PATH, (c) => c.html(loginPage()))
  app.get(CONSENT_PATH, async (c) => {
    const clientId = c.req.query('client_id') ?? ''
    const row = await sql<{ name: string | null }>`
      select name from "oauthClient" where "clientId" = ${clientId}
    `.execute(db)
    return c.html(consentPage(row.rows[0]?.name ?? 'An unknown app'))
  })

  // --- MCP -----------------------------------------------------------------
  let ownerId: string | undefined
  const resolveOwnerId = async () => {
    if (ownerId) return ownerId
    const row = await sql<{ id: string }>`select id from "user" where lower(email) = ${env.OWNER_EMAIL}`.execute(db)
    ownerId = row.rows[0]?.id
    return ownerId
  }

  const mcpHandler = requireMcpAuth(
    auth,
    async (request, claims) => {
      // Tokens are only ever minted for the owner, but check anyway: a token for any other subject is refused.
      if (!claims.sub || claims.sub !== (await resolveOwnerId())) {
        return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Forbidden' }, id: null }, { status: 403 })
      }
      const server = createMcpServer(db)
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      await server.connect(transport)
      return transport.handleRequest(request)
    },
    { resource },
  )
  app.all('/mcp', (c) => mcpHandler(c.req.raw))

  // --- WhatsApp ingestion --------------------------------------------------
  app.route('/webhooks/whatsapp', webhookRoutes(deps))
  // Linking the number (Meta Embedded Signup), for the signed-in owner.
  app.route('/whatsapp', whatsappAccountRoutes(deps, deps.metaSignup ?? readMetaSignupConfig()))

  // Vercel cron: retry anything the post-response processing didn't finish.
  const isCron = (header: string | undefined) => safeEqual(header ?? '', `Bearer ${env.CRON_SECRET}`)
  app.get('/cron/drain', async (c) => {
    if (!isCron(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401)
    const result = await drainPendingEvents(db)
    return c.json(result)
  })

  // Vercel cron, daily: delete messages older than the retention window set at /whatsapp.
  app.get('/cron/purge', async (c) => {
    if (!isCron(c.req.header('authorization'))) return c.json({ error: 'unauthorized' }, 401)
    return c.json(await purgeExpired(db))
  })

  return app
}
