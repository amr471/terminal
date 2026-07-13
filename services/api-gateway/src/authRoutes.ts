/**
 * /auth/* routes: signup, login, logout, me, and Google + Telegram OAuth.
 * Every response goes through AppError/sendAppError so failures map to the
 * shared GW-* registry; every state-changing action is audited
 * (trading-security: "audit events to audit_log — meta must be secret-free").
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { negotiateLocale } from '@terminal/i18n';
import {
  signupSchema,
  loginSchema,
  googleCallbackSchema,
  discordCallbackSchema,
  telegramLoginSchema,
  telegramCallbackQuerySchema,
} from './authSchemas.js';
import { hashPassword, verifyPasswordTimingSafe } from './password.js';
import { isLoginLocked, recordLoginFailure, clearLoginFailures } from './loginThrottle.js';
import { issueSession, revokeSession, verifySession } from './session.js';
import { SESSION_COOKIE, readSessionToken, requireSession } from './sessionAuth.js';
import {
  findUserByEmail,
  createUserWithPassword,
  findOAuthUserId,
  linkOrCreateOAuthUser,
} from './users.js';
import { recordAuditEvent } from './audit.js';
import { AppError, sendAppError } from './errors.js';
import { buildGoogleAuthUrl, exchangeGoogleCode } from './googleAuth.js';
import { buildDiscordAuthUrl, exchangeDiscordCode } from './discordAuth.js';
import { verifyTelegramLogin } from './telegramAuth.js';
import { config, SESSION_TTL_MS } from './config.js';
import { pool } from './db.js';
import { redis } from './redis.js';

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

    // Per-account lockout (keyed by the raw email, same as the failure counter below)
    // guards against distributed brute force that spreads across many IPs to stay
    // under the flat per-IP rate limit. Checked before touching Postgres/argon2 so a
    // locked-out attacker can't use response timing to distinguish this from GW-2001.
    if (await isLoginLocked(redis, email)) {
      await recordAuditEvent(pool, 'auth.login_failed', null, {
        method: 'password',
        reason: 'locked',
      });
      return sendAppError(reply, new AppError('GW-2004'));
    }

    const user = await findUserByEmail(pool, email);
    const ok = await verifyPasswordTimingSafe(user?.password_hash, password);
    if (!user || !ok) {
      // Same error for "no such user" and "wrong password" — don't leak which one (GW-2001).
      await recordLoginFailure(redis, email);
      await recordAuditEvent(pool, 'auth.login_failed', user?.id ?? null, { method: 'password' });
      return sendAppError(reply, new AppError('GW-2001'));
    }

    await clearLoginFailures(redis, email);
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

        // Hoisted so it's available for the post-login redirect below
        // regardless of whether this is a new or an existing user.
        const locale = negotiateLocale(request.headers['accept-language']);

        let userId = await findOAuthUserId(pool, 'google', identity.sub);
        let isNewUser = false;
        if (!userId) {
          const linked = await linkOrCreateOAuthUser(pool, 'google', identity.sub, {
            email: identity.email,
            locale,
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

        // Back to the actual web app's terminal (P1.2c), never the
        // gateway's own bare address — see config.ts's webAppOrigin comment.
        return reply.redirect(`${config.webAppOrigin}/${locale}/terminal`);
      } catch {
        return sendAppError(reply, new AppError('GW-2007', { provider: 'google' }));
      }
    },
  );

  // ── Discord OAuth ───────────────────────────────────────────────────────
  app.get('/auth/discord', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (_request, reply) => {
    if (!config.discord) {
      return sendAppError(reply, new AppError('GW-2007', { provider: 'discord' }));
    }
    const state = randomBytes(16).toString('base64url');
    await redis.set(`oauth:state:${state}`, '1', 'EX', OAUTH_STATE_TTL_SECONDS);
    return reply.redirect(buildDiscordAuthUrl(state));
  });

  app.get(
    '/auth/discord/callback',
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      if (!config.discord) {
        return sendAppError(reply, new AppError('GW-2007', { provider: 'discord' }));
      }
      const parsed = discordCallbackSchema.safeParse(request.query);
      if (!parsed.success) return sendAppError(reply, new AppError('GW-2008'));

      const stateKey = `oauth:state:${parsed.data.state}`;
      const stateOk = await redis.del(stateKey); // atomic check-and-consume
      if (!stateOk) return sendAppError(reply, new AppError('GW-2007', { provider: 'discord' }));

      try {
        const identity = await exchangeDiscordCode(parsed.data.code);
        if (!identity.verified) {
          return sendAppError(
            reply,
            new AppError('GW-2007', { provider: 'discord', reason: 'email_unverified' }),
          );
        }

        const locale = negotiateLocale(request.headers['accept-language']);

        let userId = await findOAuthUserId(pool, 'discord', identity.id);
        let isNewUser = false;
        if (!userId) {
          const linked = await linkOrCreateOAuthUser(pool, 'discord', identity.id, {
            email: identity.email,
            locale,
            ...(identity.username !== undefined ? { displayName: identity.username } : {}),
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
          method: 'discord',
        });

        return reply.redirect(`${config.webAppOrigin}/${locale}/terminal`);
      } catch {
        return sendAppError(reply, new AppError('GW-2007', { provider: 'discord' }));
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

  // Redirect-link variant (P1.2c) — Telegram's oauth.telegram.org "Login URL"
  // method delivers the same signed payload as the widget above, but as GET
  // query params on a full-page redirect back here, rather than a JS
  // callback. This is what lets the landing page's Telegram button be a
  // plain styled <a>, matching Google/Discord, instead of Telegram's own
  // widget iframe.
  app.get(
    '/auth/telegram/callback',
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      if (!config.telegram) {
        return sendAppError(reply, new AppError('GW-2007', { provider: 'telegram' }));
      }
      const parsed = telegramCallbackQuerySchema.safeParse(request.query);
      if (!parsed.success) return sendAppError(reply, new AppError('GW-2008'));

      const valid = verifyTelegramLogin(parsed.data, config.telegram.botToken);
      if (!valid) return sendAppError(reply, new AppError('GW-2007', { provider: 'telegram' }));

      const locale = negotiateLocale(request.headers['accept-language']);
      const providerAccountId = String(parsed.data.id);
      let userId = await findOAuthUserId(pool, 'telegram', providerAccountId);
      let isNewUser = false;
      if (!userId) {
        const displayName = [parsed.data.first_name, parsed.data.last_name]
          .filter(Boolean)
          .join(' ');
        const linked = await linkOrCreateOAuthUser(pool, 'telegram', providerAccountId, {
          email: null, // Telegram never provides one — see migration 0003
          locale,
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

      return reply.redirect(`${config.webAppOrigin}/${locale}/terminal`);
    },
  );
}

// Re-exported for tests that need these without importing config.js/sessionAuth.js directly.
export { SESSION_TTL_MS, SESSION_COOKIE };
