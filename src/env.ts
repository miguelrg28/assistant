export interface Env {
  DATABASE_URL: string
  /** Public origin of the deployment, e.g. https://whatsapp-mcp.vercel.app (no trailing slash). */
  BASE_URL: string
  BETTER_AUTH_SECRET: string
  /** The only account allowed to authorize MCP clients. */
  OWNER_EMAIL: string
  /** Meta app secret, used to verify X-Hub-Signature-256 on webhooks. */
  META_APP_SECRET: string
  /** Arbitrary string you also type into the Meta webhook config (GET verification). */
  META_VERIFY_TOKEN: string
  /** Vercel sends `Authorization: Bearer $CRON_SECRET` on cron invocations. */
  CRON_SECRET: string
}

const REQUIRED = [
  'DATABASE_URL',
  'BASE_URL',
  'BETTER_AUTH_SECRET',
  'OWNER_EMAIL',
  'META_APP_SECRET',
  'META_VERIFY_TOKEN',
  'CRON_SECRET',
] as const satisfies readonly (keyof Env)[]

export type AuthEnv = Pick<Env, 'DATABASE_URL' | 'BASE_URL' | 'BETTER_AUTH_SECRET' | 'OWNER_EMAIL'>

/** Just what the database + auth scripts need; they don't touch Meta or cron. */
export const AUTH_KEYS = ['DATABASE_URL', 'BASE_URL', 'BETTER_AUTH_SECRET', 'OWNER_EMAIL'] as const satisfies readonly (keyof Env)[]

export function readEnv(source?: Record<string, string | undefined>): Env
export function readEnv<K extends keyof Env>(source: Record<string, string | undefined> | undefined, keys: readonly K[]): Pick<Env, K>
export function readEnv(
  input: Record<string, string | undefined> = process.env,
  keys: readonly (keyof Env)[] = REQUIRED,
): Partial<Env> {
  // Vercel's Neon integration prefixes its variables with the name chosen at install time
  // (e.g. STORAGE_DATABASE_URL, the pooled string). Accept that when DATABASE_URL isn't set.
  const source: Record<string, string | undefined> = { ...input, DATABASE_URL: input.DATABASE_URL || input.STORAGE_DATABASE_URL }
  const missing = keys.filter((key) => !source[key])
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. ` +
        'Locally, put them in .env or .env.local (see .env.example); on Vercel, set them in Project → Settings → Environment Variables.',
    )
  }
  const env: Partial<Env> = Object.fromEntries(keys.map((key) => [key, source[key]!]))
  if (env.BASE_URL) env.BASE_URL = env.BASE_URL.replace(/\/+$/, '')
  if (env.OWNER_EMAIL) env.OWNER_EMAIL = env.OWNER_EMAIL.toLowerCase()
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error('BETTER_AUTH_SECRET must be at least 32 characters')
  }
  return env
}

/**
 * Optional settings for linking the number from /whatsapp (Meta Embedded Signup). The rest of the
 * service works without them; the page just says linking isn't configured.
 */
export interface MetaSignupConfig {
  /** Meta app → App settings → Basic → App ID. */
  appId?: string
  /** WhatsApp → Embedded Signup → Configuration ID. */
  configId?: string
  graphVersion: string
  /** 32 bytes (base64 or 64 hex chars) used to encrypt the access token at rest. */
  tokenKey?: string
}

export function readMetaSignupConfig(source: Record<string, string | undefined> = process.env): MetaSignupConfig {
  return {
    appId: source.META_APP_ID?.trim() || undefined,
    configId: source.META_CONFIG_ID?.trim() || undefined,
    graphVersion: source.META_GRAPH_VERSION?.trim() || 'v23.0',
    tokenKey: source.WHATSAPP_TOKEN_KEY?.trim() || undefined,
  }
}
