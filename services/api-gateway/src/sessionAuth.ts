/**
 * Shared session-cookie resolution — used by both REST routes (authRoutes.ts)
 * and the WS gateway (ws.ts, P1.2) so "how do we know who this connection
 * is" lives in exactly one place instead of being reimplemented per
 * transport.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { pool } from './db.js';
import { redis } from './redis.js';
import { verifySession, type SessionContext } from './session.js';
import { AppError, sendAppError } from './errors.js';

export const SESSION_COOKIE = 'terminal_session';

/** Unsigns the session cookie, if present and valid. Returns the raw bearer token. */
export function readSessionToken(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const result = request.unsignCookie(raw);
  return result.valid ? result.value : null;
}

/** Resolves the caller's session, or null if absent/expired/invalid. Never replies. */
export async function resolveSession(request: FastifyRequest): Promise<SessionContext | null> {
  const token = readSessionToken(request);
  return token ? verifySession(pool, redis, token) : null;
}

/** REST helper: resolves the session or sends GW-2002 and returns null. */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionContext | null> {
  const session = await resolveSession(request);
  if (!session) {
    sendAppError(reply, new AppError('GW-2002'));
    return null;
  }
  return session;
}
