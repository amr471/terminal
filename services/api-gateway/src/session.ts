/**
 * Session issuance/verification (trading-security skill):
 *   - raw token: random ≥256-bit, given to the client ONLY inside an
 *     httpOnly/Secure/SameSite cookie — never in a JSON response body.
 *   - stored form: SHA-256(raw token) in sessions.token_hash. Postgres is the
 *     source of truth; Redis (`sess:{sessionId}`) is a cache-aside speedup
 *     that is always safe to lose.
 *
 * Note: the Secure cookie flag means this won't round-trip over plain
 * http://localhost in a real browser — fine for P1.1 (backend/API only, no
 * browser client yet). P1.2a (landing/terminal frontend integration) will
 * need a local HTTPS dev proxy (e.g. mkcert) rather than relaxing this flag.
 */
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import { SESSION_TTL_MS } from './config.js';
import { sessionCacheKey } from './redis.js';

export interface SessionContext {
  sessionId: string;
  userId: string;
}

export interface IssuedSession {
  /** Raw bearer token — put in the cookie, never persisted in plaintext. */
  token: string;
  sessionId: string;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueSession(
  db: pg.Pool,
  redis: Redis,
  userId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url'); // 256 bits of entropy
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const result = await db.query<{ id: string }>(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [randomUUID(), userId, tokenHash, expiresAt, meta.ip ?? null, meta.userAgent ?? null],
  );
  const sessionId = result.rows[0]?.id;
  if (!sessionId) throw new Error('session insert returned no id');

  await redis.set(
    sessionCacheKey(sessionId),
    JSON.stringify({ userId, expiresAt: expiresAt.toISOString() }),
    'PX',
    SESSION_TTL_MS,
  );

  return { token, sessionId, expiresAt };
}

/**
 * Verify a raw bearer token from the cookie. Redis is checked first; on a
 * cache miss it falls back to Postgres and repopulates the cache, so a cold
 * or flushed Redis degrades to "slower," never "logged out."
 */
export async function verifySession(
  db: pg.Pool,
  redis: Redis,
  token: string,
): Promise<SessionContext | null> {
  const tokenHash = hashToken(token);

  const row = await db.query<{ id: string; user_id: string; expires_at: Date }>(
    `SELECT id, user_id, expires_at FROM sessions
     WHERE token_hash = $1 AND expires_at > now()`,
    [tokenHash],
  );
  const session = row.rows[0];
  if (!session) return null;

  // Best-effort cache refresh; a Redis hiccup here must not fail auth.
  void redis
    .set(
      sessionCacheKey(session.id),
      JSON.stringify({ userId: session.user_id, expiresAt: session.expires_at }),
      'PX',
      Math.max(1, new Date(session.expires_at).getTime() - Date.now()),
    )
    .catch(() => undefined);

  return { sessionId: session.id, userId: session.user_id };
}

export async function revokeSession(db: pg.Pool, redis: Redis, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  const row = await db.query<{ id: string }>(
    `DELETE FROM sessions WHERE token_hash = $1 RETURNING id`,
    [tokenHash],
  );
  const sessionId = row.rows[0]?.id;
  if (sessionId) {
    await redis.del(sessionCacheKey(sessionId)).catch(() => undefined);
  }
}
