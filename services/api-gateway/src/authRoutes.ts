/**
 * /auth/* routes: signup, login, logout, me, and Google + Telegram OAuth.
 * Every response goes through AppError/sendAppError so failures map to the
 * shared GW-* registry; every state-changing action is audited
 * (trading-security: "audit events to audit_log — meta must be secret-free").
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { negotiateLocale } from '@terminal/i18n';
import {
  signupSchema,
  loginSchema,
  googleCallbackSchema,
  telegramLoginSchema,
} from './authSchemas.js';
import { hashPassword, verifyPasswordTimingSafe } from './password.js';
import { issueSession, revokeSession, verifySession, type SessionContext } from './session.js';
import {
  findUserByEmail,
  createUserWithPassword,
  findOAuthUserId,
  linkOrCreateOAuthUser,
} from './users.js';
import { recordAuditEvent } from './audit.js';
import { AppError, sendAppError } from './errors.js';
import { buildGoogleAuthUrl, exchangeGoogleCode } from './googleAuth.js';
import { verifyTelegramLogin } from './telegramAuth.js';
import { config, SESSION_TTL_MS } from './config.js';
import { pool } from './db.js';
import { redis } from './redis.js';

const SESSION_COOKIE = 'terminal_session';
const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes to complete the OAuth round trip
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    signed: true,
    expires: expiresAt,
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Unsigns the session cookie, if present and valid. Returns the raw bearer token. */
function readSessionToken(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const result = request.unsignCookie(raw);
  return result.valid ? result.value : null;
}

async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionContext | null> {
  const token = readSessionToken(request);
  const session = token ? await verifySession(pool, redis, token) : null;
  if (!session) {
    sendAppError(reply, new AppError('GW-2002'));
    return null;
  }
  return session;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post('/auth/signup', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) return sendAppError(reply, new AppError('GW-2008'));
    const { email, password, displayName } = parsed.data;
    const locale = parsed.data.locale ?? negotiateLocale(request.headers['accept-language']);

    const existing = await findUserByEmail(pool, email);
    if (existing) return sendAppError(reply, new AppError('GW-2006'));

    const passwordHash = await hashPassword(password);
    const userId = await createUserWithPassword(pool, {
      email,
      passwordHash,
      locale,
      ...(displayName !== undefined ? { displayName } : {}),
    });

    const session = await issueSession(pool, redis, userId, {
      ...(request.ip !== undefined ? { ip: request.ip } : {}),
      userAgent: request.headers['user-agent'] ?? '',
    });
    setSessionCookie(reply, session.token, session.expiresAt);
    await recordAuditEvent(pool, 'auth.signup', userId, { method: 'password' });

    return reply.code(201).send({ userId, locale });
  });

  app.post('/auth/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return sendAppError(reply, new AppError('GW-2008'));
    const { email, password } = parsed.data;

    const user = await findUserByEmail(pool, email);
    const ok = await verifyPasswordTimingSafe(user?.password_hash, password);
    if (!user || !ok) {
      // Same error for "no such user" and "wrong password" — don't leak which one (GW-2001).
      await recordAuditEvent(pool, 'auth.login_failed', user?.id ?? null, { method: 'password' });
      return sendAppError(reply, new AppError('GW-2001'));
    }

    const session = await issueSession(pool, redis, user.id, {
      ...(request.ip !== undefined ? { ip: request.ip } : {}),
      userAgent: request.headers['user-agent'] ?? '',
    });
    setSessionCookie(reply, session.token, session.expiresAt);
    await recordAuditEvent(pool, 'auth.login', user.id, { method: 'password' });

    return reply.send({ userId: user.id, locale: user.locale });
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = readSessionToken(request);
    const session = token ? await verifySession(pool, redis, token) : null;
    if (token) await revokeSession(pool, redis, token);
    clearSessionCookie(reply);
    if (session) await recordAuditEvent(pool, 'auth.logout', session.userId);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return; // requireSession already sent the error response
    const user = await pool.query<{ id: string; email: string | null; locale: string }>(
      `SELECT id, email, locale FROM users WHERE id = $1`,
      [session.userId],
    );
    return reply.send(user.rows[0]);
  });

  // ── Google OAuth ────────────────────────────────────────────────────────
  app.get('/auth/google', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (_request, reply) => {
    if (!config.google) {
      return sendAppError(reply, new AppError('GW-2007', { provider: 'google' }));
    }
    const state = randomBytes(16).toString('base64url');
    await redis.set(`oauth:state:${state}`, '1', 'EX', OAUTH_STATE_TTL_SECONDS);
    return reply.redirect(buildGoogleAuthUrl(state));
  });

  app.get(
    '/auth/google/callback',
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      if (!config.google) {
        return sendAppError(reply, new AppError('GW-2007', { provider: 'google' }));
      }
      const parsed = googleCallbackSchema.safeParse(request.query);
      if (!parsed.success) return sendAppError(reply, new AppError('GW-2008'));

      const stateKey = `oauth:state:${parsed.data.state}`;
      const stateOk = await redis.del(stateKey); // atomic check-and-consume
      if (!stateOk) return sendAppError(reply, new AppError('GW-2007', { provider: 'google' }));

      try {
        const identity = await exchangeGoogleCode(parsed.data.code);
        if (!identity.emailVerified) {
          return sendAppError(
            reply,
            new AppError('GW-2007', { provider: 'google', reason: 'email_unverified' }),
          );
        }

        let userId = await findOAuthUserId(pool, 'google', identity.sub);
        let isNewUser = false;
        if (!userId) {
          const linked = await linkOrCreateOAuthUser(pool, 'google', identity.sub, {
            email: identity.email,
            locale: negotiateLocale(request.headers['accept-language']),
            ...(identity.name !== undefined ? { displayName: identity.name } : {}),
          });
          userId = linked.userId;
          isNewUser = linked.created;
        }

        const session = await issueSession(pool, redis, userId, {
          ...(request.ip !== undefined ? { ip: request.ip } : {}),
          userAgent: request.headers['user-agent'] ?? '',
        });
        setSessionCookie(reply, session.token, session.expiresAt);
        await recordAuditEvent(pool, isNewUser ? 'auth.signup' : 'auth.login', userId, {
          method: 'google',
        });

        return reply.redirect(config.publicApiUrl);
      } catch {
        return sendAppError(reply, new AppError('GW-2007', { provider: 'google' }));
      }
    },
  );

  // ── Telegram Login Widget ───────────────────────────────────────────────
  app.post('/auth/telegram', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    if (!config.telegram) {
      return sendAppError(reply, new AppError('GW-2007', { provider: 'telegram' }));
    }
    const parsed = telegramLoginSchema.safeParse(request.body);
    if (!parsed.success) return sendAppError(reply, new AppError('GW-2008'));

    const valid = verifyTelegramLogin(parsed.data, config.telegram.botToken);
    if (!valid) return sendAppError(reply, new AppError('GW-2007', { provider: 'telegram' }));

    const providerAccountId = String(parsed.data.id);
    let userId = await findOAuthUserId(pool, 'telegram', providerAccountId);
    let isNewUser = false;
    if (!userId) {
      const displayName = [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(' ');
      const linked = await linkOrCreateOAuthUser(pool, 'telegram', providerAccountId, {
        email: null, // Telegram never provides one — see migration 0003
        locale: negotiateLocale(request.headers['accept-language']),
        ...(displayName ? { displayName } : {}),
      });
      userId = linked.userId;
      isNewUser = linked.created;
    }

    const session = await issueSession(pool, redis, userId, {
      ...(request.ip !== undefined ? { ip: request.ip } : {}),
      userAgent: request.headers['user-agent'] ?? '',
    });
    setSessionCookie(reply, session.token, session.expiresAt);
    await recordAuditEvent(pool, isNewUser ? 'auth.signup' : 'auth.login', userId, {
      method: 'telegram',
    });

    return reply.send({ userId });
  });
}

// Re-exported for tests that need the session TTL without importing config directly.
export { SESSION_TTL_MS, SESSION_COOKIE };
