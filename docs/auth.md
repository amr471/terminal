# Auth (P1.1)

Implemented in `services/api-gateway` (Fastify). Session model, endpoints, and
the OAuth flows added in P1.1. Security rules are the trading-security skill's
job; this doc is the "what exists and how it fits together" reference.

## Session model

- Opaque bearer token, 256 bits of randomness (`node:crypto.randomBytes(32)`),
  never a JWT. Stored as SHA-256 in `sessions.token_hash`; the raw token lives
  **only** in an httpOnly/Secure/SameSite=Lax cookie (`terminal_session`),
  additionally signed by Fastify's cookie plugin (`SESSION_SECRET`) as
  defense in depth.
- Postgres (`sessions` table) is the source of truth. Redis
  (`sess:{sessionId}`, architecture.md §4.1) is a cache-aside speedup with a
  TTL matching session expiry — safe to lose; `verifySession` falls back to
  Postgres and repopulates the cache on a miss.
- Session lifetime: 30 days (`SESSION_TTL_MS` in `config.ts`).
- The `Secure` cookie flag means sessions won't round-trip over plain
  `http://localhost` in an actual browser yet. Fine for P1.1 (API-only, no
  frontend wiring). P1.2a (landing/terminal integration) needs a local HTTPS
  dev proxy (e.g. mkcert) rather than relaxing this flag.

## Endpoints

| Method | Path                    | Auth required | Notes                                                     |
| ------ | ----------------------- | ------------- | --------------------------------------------------------- |
| POST   | `/auth/signup`          | no            | email+password, argon2id hash, issues a session           |
| POST   | `/auth/login`           | no            | same error for unknown email and wrong password (GW-2001) |
| POST   | `/auth/logout`          | no (cookie)   | revokes the session if present, always clears the cookie  |
| GET    | `/auth/me`              | yes           | returns `{id, email, locale}`                             |
| GET    | `/auth/google`          | no            | redirects to Google; 401 GW-2007 if not configured        |
| GET    | `/auth/google/callback` | no            | exchanges code, verifies `id_token`, links/creates a user |
| GET    | `/auth/discord`         | no            | redirects to Discord; 401 GW-2007 if not configured       |
| GET    | `/auth/discord/callback`| no            | exchanges code, checks `verified`, links/creates a user   |
| POST   | `/auth/telegram`        | no            | verifies the Login Widget HMAC, links/creates a user      |
| GET    | `/auth/telegram/callback`| no           | same verification, redirect-link variant (P1.2c)          |

All auth endpoints (signup/login/telegram) are rate-limited to 10 req/min per
IP on top of the gateway's global 100 req/min (trading-security: "Rate-limit
auth endpoints (GW-2004)").

`/auth/login` additionally has a **per-account** failure lockout
(`loginThrottle.ts`): 10 failed attempts within 15 minutes for a given email
locks that email out (GW-2004) regardless of source IP. This closes a gap the
IP-only limit leaves open — a distributed attacker spreading attempts across
many IPs never trips the per-IP limit but would still be caught here. Keyed
by the raw email string (not user id), so behavior is identical whether the
email belongs to a real account or not, preserving the same
no-enumeration property as GW-2001 and `verifyPasswordTimingSafe`.

## OAuth account linking

All three providers write into the existing `oauth_accounts` table
(`provider`, `provider_account_id` → `user_id`), never a provider-specific
table:

- **Google**: authorization-code + OIDC flow via `google-auth-library`. State
  is a random token held in Redis (`oauth:state:{state}`, 10 min TTL,
  check-and-consume via `DEL`) to prevent CSRF. Only a **verified** Google
  email is trusted for account linking to an existing password/email user;
  an unverified email creates/links nothing (GW-2007). **Frontend (P1.2c):**
  a plain `<a href="/api/auth/google">` link on the landing page — no client
  JS needed, it's a full-page navigation through the same-origin proxy.
- **Discord** (P1.1a): plain OAuth2 authorization-code flow — Discord has no
  OIDC `id_token`, so `discordAuth.ts` uses `fetch()` directly (token
  exchange, then `GET /users/@me`) rather than a client library. Same Redis
  state/CSRF pattern as Google. Discord's own `verified` flag on the profile
  is the same trust gate Google's `email_verified` is — an unverified email
  creates/links nothing (GW-2007).
- **Telegram**: [Login Widget](https://core.telegram.org/widgets/login)
  payload, verified with `TELEGRAM_BOT_TOKEN` per Telegram's documented
  HMAC-SHA256 scheme (`telegramAuth.ts`, no network call, no third-party
  library). Telegram never provides an email — `users.email` was relaxed to
  nullable in migration `0003_users_email_nullable.sql` specifically for this
  case. **Not** the same thing as `tg_links` (owned by `telegram-bot`,
  `services/telegram-bot/migrations/0001_tg_links.sql`): that table is for
  bot alert delivery (chat_id, deep-link verification, P1.13/P2.4), separate
  from "log into the web app with your Telegram account."
  **Frontend (P1.2c):** the landing page renders a plain `<a>` styled
  identically to the Google/Discord buttons, not Telegram's own widget
  iframe. It links to Telegram's ["Login URL" redirect
  method](https://core.telegram.org/widgets/login#link-with-a-bot-username)
  (`https://oauth.telegram.org/auth?bot_id=...&origin=...&return_to=...`),
  which sends the browser to Telegram, then redirects it back to
  `GET /auth/telegram/callback` with the signed payload as query params —
  same shape as the widget's callback, just coerced from strings
  (`telegramCallbackQuerySchema`) instead of arriving as JS values, and
  handled the same way `verifyTelegramLogin` always has. `POST
  /auth/telegram` (the original JS-callback/widget endpoint) still exists
  unchanged, in case a future surface wants the embedded widget instead.
  Requires `TELEGRAM_BOT_ID` (public — the numeric prefix of the bot token,
  not the token itself) so the frontend can build the link, and **the bot's
  domain must be authorized via @BotFather's `/setdomain` command** before
  Telegram will redirect back to it — an account-setup step, not something
  fixable in code.

Both providers are optional at the env level — if credentials are absent,
their routes return 401 `GW-2007` instead of the gateway failing to start.

### Local env loading (fixed at P1.2c)

Neither `pnpm dev:web` (`next dev`, which only auto-loads `.env` files from
its own directory) nor `pnpm dev:gateway` (plain `node --watch`) ever read
the root `.env` — only `scripts/dev-env.sh` (`dev:up`/`dev:migrate`) sources
it, for the Postgres bootstrap. That meant every OAuth env var above was
silently invisible to both dev processes unless exported into the shell by
hand. Both packages' `dev` scripts now run through `dotenv-cli`
(`dotenv -e ../../.env -- ...`) so `.env` is loaded the same way for every
local process. No code path changed — `process.env.*` reads are unchanged —
this only fixes how the values get there in local dev.

### Post-login redirect (fixed at P1.2c)

Google/Discord's callbacks originally did `reply.redirect(config.publicApiUrl)`
— sent the browser to the gateway's own bare address after a successful
login. Harmless at P1.1 (no frontend existed yet to redirect to), but wrong
once the terminal shipped. Fixed: a new `WEB_APP_ORIGIN` env var (defaults to
`https://localhost:3000`, the mkcert-backed dev origin) and the callback now
redirects to `${WEB_APP_ORIGIN}/${locale}/terminal` instead.

This also means each provider's **redirect URI must point through
`apps/web`'s same-origin `/api/*` proxy** (`next.config.mjs`,
docs/landing-page.md), not straight at the gateway —
`https://localhost:3000/api/auth/google/callback`, not
`http://localhost:8080/auth/google/callback`. Otherwise the `Secure` session
cookie sets on the gateway's origin, which the browser never sends back on
subsequent same-origin requests to the web app. `GOOGLE_OAUTH_REDIRECT_URI`/
`DISCORD_OAUTH_REDIRECT_URI`'s defaults (`config.ts`) already build the
correct proxied URL from `WEB_APP_ORIGIN`; this only matters if you override
either explicitly (e.g. for a real deployment) — make sure whatever you
register in Google/Discord's own developer console matches.

## Error codes (GW-2001–2009, `@terminal/types`)

Added in P1.1: `GW-2006` (email already registered), `GW-2007` (OAuth
verification failed / provider not configured), `GW-2008` (invalid request
payload), `GW-2009` (internal error, generic 500). See
`packages/types/src/errors.ts` for the full registry and architecture.md
§5.7 for the convention (never renumber, only append).

## Audit events

`auth.signup`, `auth.login`, `auth.login_failed`, `auth.logout` → `audit_log`,
written via `audit.ts`'s `recordAuditEvent`, which refuses to write any
`meta` key that looks secret-bearing (`assertSecretFreeMeta`) before the
insert happens — a defensive check, not just a code-review convention.

## Testing

- `password.test.ts`, `telegramAuth.test.ts` — pure unit tests, no external
  services, always run.
- `session.test.ts`, `app.test.ts` — integration tests against a real local
  Postgres+Redis. They check reachability first and skip (not fail) if the
  local stack isn't up, so `pnpm test` still passes on a machine without
  Docker running. CI provides real Postgres+Redis service containers
  (`.github/workflows/ci.yml`) so these run for real on every push/PR; for
  local verification, `pnpm dev:up && pnpm dev:migrate && pnpm test`.
