/**
 * Fastify app factory (ADR-003: Node/TS + Fastify + ws). Split from index.ts
 * so tests can build the app in-process via `app.inject()` without binding a
 * real port.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { registerAuthRoutes } from './authRoutes.js';
import { registerMarketRoutes } from './marketRoutes.js';
import { registerLayoutRoutes } from './layoutRoutes.js';
import { registerWsRoute } from './ws.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { isSubscriberReady } from './pubsub.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, trustProxy: true });

  await app.register(cookie, { secret: config.sessionCookieSecret });
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    // GW-2004 — shared error registry, not @fastify/rate-limit's default body shape.
    errorResponseBuilder: () => ({
      error: { code: 'GW-2004', message: 'Rate limit exceeded' },
    }),
  });
  // Small control-frame payload cap (subscribe/unsubscribe messages are tiny);
  // does not limit the size of what the gateway fans out to clients.
  await app.register(websocket, { options: { maxPayload: 65536 } });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      if (!isSubscriberReady()) throw new Error('pubsub subscriber not ready');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  registerAuthRoutes(app);
  registerMarketRoutes(app);
  registerLayoutRoutes(app);
  registerWsRoute(app);

  app.setErrorHandler((err, _request, reply) => {
    app.log.error({ err }, 'unhandled error');
    // Never leak internals (stack traces, DB errors) to the client (CLAUDE.md §9).
    reply.code(500).send({ error: { code: 'GW-2009', message: 'Internal error' } });
  });

  return app;
}
