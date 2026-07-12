/**
 * Environment configuration (P1.1). Parsed once at startup with zod so a
 * misconfigured deploy fails fast and loud rather than misbehaving quietly.
 *
 * OAuth providers are optional at the env level: if a provider's credentials
 * are absent, its routes respond 501 instead of crashing the whole gateway
 * (CLAUDE.md — "every third-party feed is assumed unreliable", generalized to
 * "every optional integration must degrade visibly, not take the app down").
 */
import { z } from 'zod';

// Local-dev-only fallbacks — match the values db/dev/set-passwords.sql and
// docker-compose.yml already publish in plaintext in .env.example (P1.0).
// Any real environment sets its own env vars, which simply override these
// zod defaults; nothing here is a production secret.
const LOCAL_DEV_DATABASE_URL = 'postgres://svc_api_gateway:dev_local_only@localhost:5432/terminal';
const LOCAL_DEV_REDIS_URL = 'redis://localhost:6379';
const LOCAL_DEV_SESSION_SECRET = 'dev-only-insecure-session-secret-change-me';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL_API_GATEWAY: z.string().min(1).default(LOCAL_DEV_DATABASE_URL),
  REDIS_URL: z.string().min(1).default(LOCAL_DEV_REDIS_URL),
  // Signs the session cookie (defense in depth on top of the DB-verified opaque
  // token — CLAUDE.md §9 / trading-security). Never the token itself.
  SESSION_SECRET: z
    .string()
    .min(16, 'SESSION_SECRET must be at least 16 characters')
    .default(LOCAL_DEV_SESSION_SECRET),
  NEXT_PUBLIC_API_URL: z.string().url().default('http://localhost:8080'),

  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Config errors are developer-facing, never secret-bearing — safe to log in full.
  console.error('[api-gateway] invalid environment configuration:', parsed.error.flatten());
  throw new Error('Invalid environment configuration');
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  databaseUrl: env.DATABASE_URL_API_GATEWAY,
  redisUrl: env.REDIS_URL,
  sessionCookieSecret: env.SESSION_SECRET,
  publicApiUrl: env.NEXT_PUBLIC_API_URL,
  google:
    env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
      ? {
          clientId: env.GOOGLE_OAUTH_CLIENT_ID,
          clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          redirectUri:
            env.GOOGLE_OAUTH_REDIRECT_URI ?? `${env.NEXT_PUBLIC_API_URL}/auth/google/callback`,
        }
      : undefined,
  telegram: env.TELEGRAM_BOT_TOKEN ? { botToken: env.TELEGRAM_BOT_TOKEN } : undefined,
} as const;

/** Session lifetime — 30 days, matches typical "stay signed in" trading-terminal UX. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
