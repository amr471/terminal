/**
 * /layouts/* — the terminal shell's saved workspace (P1.3). Structural
 * validation delegates to @terminal/types' validateLayoutDefinition (the
 * same guard the frontend and tests use) rather than duplicating the shape
 * in a parallel zod schema — one source of truth for "what's a valid
 * layout," same pattern screener.ts's filter-tree guard already sets.
 */
import type { FastifyInstance } from 'fastify';
import { validateLayoutDefinition, type LayoutDefinition } from '@terminal/types';
import { requireSession } from './sessionAuth.js';
import { AppError, sendAppError } from './errors.js';
import { getDefaultLayout, saveDefaultLayout } from './layouts.js';
import { pool } from './db.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerLayoutRoutes(app: FastifyInstance): void {
  app.get('/layouts/default', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const definition = await getDefaultLayout(pool, session.userId);
    return reply.send({ definition });
  });

  app.put('/layouts/default', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const body = request.body;
    if (!isPlainObject(body) || !('definition' in body)) {
      return sendAppError(reply, new AppError('GW-2008'));
    }
    const errors = validateLayoutDefinition(body.definition);
    if (errors.length > 0) {
      return sendAppError(reply, new AppError('GW-2010', { detail: errors[0] ?? 'invalid' }));
    }

    await saveDefaultLayout(pool, session.userId, body.definition as LayoutDefinition);
    return reply.send({ ok: true });
  });
}
