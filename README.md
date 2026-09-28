# WhatsApp MCP (personal, read-only)

This service stores **your** WhatsApp Business 1:1 chats and lets claude.ai read and search them through a custom connector. It is built for one user.

It connects to the Meta Cloud API directly, using **Coexistence**. Your phone app keeps working, and up to 6 months of 1:1 history is synced once. Group chats are not delivered by Coexistence, so they're out of scope.

**It is read-only.** No endpoint or tool sends WhatsApp messages. The only calls to Meta are the ones that link your number at `/whatsapp` (Embedded Signup) and request the one-time history and contacts sync.

```
Meta webhooks ──▶ POST /webhooks/whatsapp ──▶ webhook_events (raw, signed) ──▶ processor ──▶ contacts / chats / messages
                                                                                                   │
claude.ai ──OAuth 2.1 (Better Auth)──▶ /mcp (Streamable HTTP, stateless) ◀── Postgres full-text search (Spanish)
```

## Stack

| Layer | Choice |
|---|---|
| Runtime | Vercel Functions (Node, Fluid compute), Hono |
| Database | Postgres (Neon) via `pg` + Kysely |
| Auth | Better Auth + `@better-auth/mcp`: OAuth 2.1 with PKCE, dynamic client registration, JWT access tokens bound to `/mcp` |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP in stateless JSON mode |
| Tests | Vitest + PGlite (in-memory Postgres, no Docker) |

## MCP tools

| Tool | What it does |
|---|---|
| `list_chats` | Chats ordered by latest activity, with who spoke last and a preview. Uses cursor pagination. |
| `get_conversation` | One chat's messages, oldest → newest. Look up the chat by `chat_id` or by contact name/number. Page with `before`/`after` cursors. |
| `search_messages` | Full-text search with Spanish stemming that ignores accents. Supports `"phrases"`, `OR` and `-exclude`. Optional contact and date filters. Returns highlighted snippets with surrounding messages. |
| `list_unanswered` | Chats where the contact wrote last, at least `hours` ago (default 4). Longest wait first. Reactions don't count as writing. |
| `find_contact` | Fuzzy match on name (ignores accents, tolerates typos) or any part of the phone number. |

Results are compact JSON and never include the raw webhook payload.

## Security model

- **Webhooks:** every request is authenticated before it's parsed. The service checks `X-Hub-Signature-256`, an HMAC-SHA256 of the **raw** body using your Meta app secret, compared in constant time. Unsigned, wrongly signed or tampered requests get a 401 and nothing is stored. The GET handshake checks `hub.verify_token` in constant time.
- **MCP:** `/mcp` needs a Bearer JWT that was signed by this server, is bound to `https://<your-app>/mcp`, hasn't expired, **and** whose `sub` is the owner's user id. Anything else gets a 401 or 403. The 401 includes the `WWW-Authenticate` header that claude.ai uses to start sign-in.
- **Single user, locked three ways:**
  1. Sign-up is disabled.
  2. A database hook rejects any user row whose email isn't `OWNER_EMAIL`.
  3. The MCP handler checks the token subject.
- **Brute force:** sign-in is rate-limited, with the limits stored in Postgres so they hold across instances.
- **Privacy:** the service never logs message bodies. Media is stored as metadata only (id, mime type, filename, caption) and is never downloaded. Secrets are read only from environment variables.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string (`…-pooler…`, `sslmode=require`). If you installed Neon from Vercel with a custom prefix, `STORAGE_DATABASE_URL` is accepted as well. |
| `BASE_URL` | Public origin, e.g. `https://whatsapp-mcp.vercel.app`, with no trailing slash. Must match the URL claude.ai uses. |
| `BETTER_AUTH_SECRET` | 32+ random characters: `openssl rand -base64 48` |
| `OWNER_EMAIL` | The only account that can sign in |
| `META_APP_SECRET` | Meta app → App settings → Basic → App secret |
| `META_VERIFY_TOKEN` | Any random string. Enter the same value in Meta's webhook settings. |
| `CRON_SECRET` | `openssl rand -hex 32`. Vercel sends it to `/cron/drain`. |

To link the number from `/whatsapp` (optional; without them the page says linking isn't configured):

| Variable | Purpose |
|---|---|
| `META_APP_ID` | Meta app → App settings → Basic → App ID |
| `META_CONFIG_ID` | WhatsApp → Embedded Signup → Configurations → Configuration ID |
| `WHATSAPP_TOKEN_KEY` | `openssl rand -base64 32`. Encrypts the linked access token (AES-256-GCM) in the database. Changing it means linking again. |
| `META_GRAPH_VERSION` | Graph API version, default `v23.0` |

The scripts need these only when you run them, not in Vercel:

| Variable | Used by |
|---|---|
| `OWNER_PASSWORD` | `npm run owner:create` (at least 12 characters) |
| `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID` | `npm run whatsapp:sync`, only to override the number linked at `/whatsapp` |

For local scripts, put values in `.env.local` (what `vercel env pull` writes) or `.env`. Both are git-ignored and loaded automatically. `db:migrate` and `owner:create` only need `DATABASE_URL`, `BASE_URL`, `BETTER_AUTH_SECRET` and `OWNER_EMAIL`.

## Deploy (Vercel)

1. **Database.** In Vercel go to Storage → Create → Neon (free tier), or create a database on neon.tech. Copy the **pooled** connection string.
2. **Project.** Import this repo as a new Vercel project in your team. Vercel detects Hono on its own, so you don't need to change any build settings. Add every variable from the first table above, for Production.
3. **Deploy**, then set `BASE_URL` to the final production URL (or your custom domain) and redeploy.
4. **Migrate and create your account** from your machine, with `.env` pointing at the production database:
   ```bash
   npm ci
   npm run db:migrate                                   # app tables + Better Auth tables; safe to re-run
   OWNER_PASSWORD='a long passphrase' npm run owner:create
   ```
   Re-run `db:migrate` after any deploy that adds a migration. Re-running `owner:create` resets the password.
5. **Check it:**
   - `curl https://<app>/` returns `ok`.
   - `curl -i -X POST https://<app>/mcp` returns `401` with a `WWW-Authenticate` header.

A Vercel cron (`vercel.json`) calls `/cron/drain` every 5 minutes. It retries any webhook event whose processing didn't finish after the response was sent.

## Register the webhook with Meta

1. Go to Meta for Developers → your app → WhatsApp → **Configuration** → Webhook.
2. Set **Callback URL** to `https://<app>/webhooks/whatsapp`.
3. Set **Verify token** to the value of `META_VERIFY_TOKEN`.
4. Click **Verify and save**. Meta calls the GET handshake, and the app echoes the challenge back.
5. Subscribe to these webhook fields:
   - `messages`: inbound messages and delivery statuses
   - `history`: the one-time history backfill
   - `smb_message_echoes`: what you send from the WhatsApp Business app
   - `smb_app_state_sync`: contacts from the app's address book

Use a **dedicated Meta app** for this. Don't reuse Emporio's, because a Meta app has only one webhook URL.

## Steps only you can do

These all happen in your Meta and WhatsApp accounts. This repo doesn't touch them.

1. **Verify your business** in Meta Business Manager (Security Center → Business verification). You need legal documents, and it can take days.
2. **Create a Meta app** (type Business), add the **WhatsApp** product and **Facebook Login for Business**.
3. **Create an Embedded Signup configuration** (WhatsApp → Embedded Signup, or Facebook Login for Business → Configurations) that allows onboarding an existing WhatsApp Business app number. Its ID is `META_CONFIG_ID`. Under Facebook Login → Settings, add your `BASE_URL` domain to **Allowed domains for the JavaScript SDK** and turn on **Login with the JavaScript SDK**. Set `META_APP_ID`, `META_CONFIG_ID` and `WHATSAPP_TOKEN_KEY` in Vercel and redeploy.
4. **Link your number.** Open `https://<app>/whatsapp`, sign in with `OWNER_EMAIL`, and click **Conectar con Meta**. In Meta's popup:
   - Choose to connect your existing WhatsApp Business app number. The app shows a QR code or prompt on your phone. Approve it.
   - When asked, turn on **Share chats / chat history**. If you skip this, `history` sends an error and no backfill happens. The service records that and does nothing else.
   - Meta requires opening the WhatsApp Business app at least every ~14 days to keep Coexistence active.

   The server then trades the popup's code for an access token, subscribes the app to your WABA with `https://<app>/webhooks/whatsapp` as the callback, stores the token encrypted and **requests the contacts and history sync right away** (Meta only accepts it for a limited time after onboarding). The page shows the linked number and when the sync was requested; **Reintentar sincronización** or `npm run whatsapp:sync` retries it. Contacts and history then arrive as webhooks, in chunks. A large archive can take a while to finish.

   **Desvincular** only forgets the number and token locally; it doesn't unsubscribe the WABA or revoke the token at Meta (do that in Meta Business Suite). The archived messages stay.
5. **Add the connector in claude.ai** (next section).

> **Check before you onboard.** Meta's rules for self-serve Embedded Signup (whether you need Tech Provider status or app review for `whatsapp_business_management` / `whatsapp_business_messaging`) and the exact deadline for requesting the sync change often. Confirm both in Meta's current Coexistence docs first. The code doesn't depend on either answer.

## Add it to claude.ai as a custom connector

1. In claude.ai go to **Settings → Connectors → Add custom connector**.
2. Name it (e.g. *WhatsApp*) and set the URL to `https://<app>/mcp`. Leave the advanced OAuth client fields empty, because claude.ai registers itself.
3. Click **Connect**. You're sent to `https://<app>/login`. Sign in with `OWNER_EMAIL` and your password, then click **Allow** on the consent screen.
4. In a chat, turn on the connector and ask things like *"¿Quién me escribió y no le he contestado en las últimas 4 horas?"* or *"Busca la cotización del sofá"*.

Access tokens last 1 hour and claude.ai refreshes them automatically.

**To revoke access:** delete the registered OAuth clients (`delete from "oauthClient";`) and sessions (`delete from session;`). Refreshing then fails right away. Access tokens are stateless JWTs, so one already issued keeps working until it expires, which is at most 1 hour. Reconnecting in claude.ai registers a new client.

## Try it with demo data

Before a real number is connected, you can load 8 fake contacts and ~30 Spanish messages. They're sent through the real webhook path, signed with your `META_APP_SECRET`:

```bash
npm run demo:seed    # needs BASE_URL and META_APP_SECRET in .env.local
npm run demo:clear   # removes only the demo data (phone numbers starting 52155500000)
```

Then ask Claude things like *"¿quién está esperando respuesta?"* or *"busca la cotización del sofá"*.

## Local development

```bash
npm ci
npm test            # in-memory Postgres, no network or Docker
npm run typecheck
npm run dev         # needs .env with a real DATABASE_URL
```

To test the webhook against a local server, sign the body the way Meta does:

```bash
BODY=$(cat test/fixtures/messages-text.json)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | sed 's/^.* /sha256=/')
curl -X POST localhost:3000/webhooks/whatsapp -H "x-hub-signature-256: $SIG" -H 'content-type: application/json' --data-binary "$BODY"
```

## Layout

```
src/
  index.ts              Vercel entry (default-exported Hono app)
  create-app.ts         Routes: OAuth, /mcp, /whatsapp, webhook, cron
  env.ts                Env validation
  auth/                 Better Auth config, login/consent pages, owner provisioning
  db/                   Kysely client, schema types, migrations
  whatsapp/             Signature check, payload → internal events, Embedded Signup, token encryption
  routes/               Webhook and /whatsapp (link the number) routes
  ingest/processor.ts   Idempotent apply + retry drain
  mcp/                  MCP server, tools, SQL
scripts/                migrate, owner:create, whatsapp:sync, dev
test/                   Vitest suites + fixtures/ (Meta webhook payloads)
```

## How ingestion behaves

- **Store first, process after.** The webhook checks the signature, stores the raw payload in `webhook_events`, replies 200, and then processes it with `waitUntil`. If processing fails, the error is recorded. The next webhook or the 5-minute cron retries it, up to 5 attempts.
- **Idempotent.** `messages.wamid` is unique, so redelivered webhooks, retries and history overlapping live messages all have no effect. Contacts and chats are upserts.
- **Order doesn't matter.** Chat markers (`last_message_at`, `last_inbound_at`, `last_outbound_at`) only ever move forward (`greatest()`). A history chunk that arrives after live messages can't move them back.
- **Direction:**
  - `messages` are inbound.
  - `smb_message_echoes` are outbound.
  - `history` messages are inbound when `from` is the thread's contact, and outbound otherwise.
- **Names.** The address-book name from `smb_app_state_sync` wins over the contact's own WhatsApp profile name.
- **Statuses** only move forward (`sent → delivered → read`). A late `delivered` never overwrites `read`.
