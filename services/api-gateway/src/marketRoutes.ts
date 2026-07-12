/**
 * REST market-data endpoints (P1.2): an initial-state snapshot so a browser
 * client isn't purely stream-driven on first paint — subscribe over /ws for
 * the live tail, but fetch this first so the panel isn't blank until the
 * next tick arrives.
 *
 * Backed by the same `cache:ticker:*` / `cache:book:*` keys market-data
 * (P1.5a) will populate (architecture.md §4.1). Both come back `null` until
 * live feeds land — expected graceful-degradation behavior for a
 * not-yet-wired feed (CLAUDE.md: "every third-party feed is assumed
 * unreliable"), not a bug in this endpoint.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSession } from './sessionAuth.js';
import { AppError, sendAppError } from './errors.js';
import { redis } from './redis.js';

const paramsSchema = z.object({
  exchange: z.string().min(1),
  symbol: z.string().min(1),
});

export function registerMarketRoutes(app: FastifyInstance): void {
  app.get('/md/snapshot/:exchange/:symbol', async (request, reply) => {
    if (!(await requireSession(request, reply))) return;

    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return sendAppError(reply, new AppError('GW-2008'));
    const { exchange, symbol } = parsed.data;

    const [tickerRaw, bookRaw] = await Promise.all([
      redis.get(`cache:ticker:${exchange}:${symbol}`),
      redis.get(`cache:book:${exchange}:${symbol}`),
    ]);

    return reply.send({
      exchange,
      symbol,
      ticker: tickerRaw ? (JSON.parse(tickerRaw) as unknown) : null,
      book: bookRaw ? (JSON.parse(bookRaw) as unknown) : null,
    });
  });
}
