/**
 * Screener REST surface (P1.6): run a filter over the working set, and manage
 * saved screens. Structural validation of a definition delegates to
 * @terminal/types (single source of truth); GW-2005 = invalid screen
 * definition, GW-2008 = malformed request, GW-2012 = screen not found.
 */
import type { FastifyInstance } from 'fastify';
import { requireSession } from './sessionAuth.js';
import { AppError, sendAppError } from './errors.js';
import { pool } from './db.js';
import { screenerHub } from './screenerHub.js';
import { validateScreenDefinition, isValidScreenName } from './screenerValidation.js';
import { listScreens, getDefinition, createScreen, updateScreen, deleteScreen } from './screens.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function registerScreenerRoutes(app: FastifyInstance): void {
  // Run a screen: an inline definition, or a saved screen / preset by id.
  app.post('/screener/query', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const body = request.body;
    if (!isPlainObject(body)) return sendAppError(reply, new AppError('GW-2008'));

    let definition;
    if ('screenId' in body && typeof body.screenId === 'string') {
      const def = await getDefinition(pool, session.userId, body.screenId);
      if (!def) return sendAppError(reply, new AppError('GW-2012'));
      definition = def;
    } else {
      const check = validateScreenDefinition(body.definition);
      if (!check.ok) return sendAppError(reply, new AppError('GW-2005', { detail: check.detail }));
      definition = check.definition;
    }

    const rows = screenerHub.query(definition);
    return reply.send({ rows, count: rows.length });
  });

  app.get('/screens', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    return reply.send({ screens: await listScreens(pool, session.userId) });
  });

  app.post('/screens', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const body = request.body;
    if (!isPlainObject(body) || !isValidScreenName(body.name)) {
      return sendAppError(reply, new AppError('GW-2008'));
    }
    const check = validateScreenDefinition(body.definition);
    if (!check.ok) return sendAppError(reply, new AppError('GW-2005', { detail: check.detail }));

    const sortKey = typeof body.sortKey === 'string' ? body.sortKey : undefined;
    const screen = await createScreen(pool, session.userId, body.name.trim(), check.definition, sortKey);
    return reply.code(201).send({ screen });
  });

  app.put('/screens/:id', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };

    const body = request.body;
    if (!isPlainObject(body)) return sendAppError(reply, new AppError('GW-2008'));

    const patch: { name?: string; definition?: import('@terminal/types').ScreenDefinition; sortKey?: string | null } = {};
    if ('name' in body && body.name !== undefined) {
      if (!isValidScreenName(body.name)) return sendAppError(reply, new AppError('GW-2008'));
      patch.name = body.name.trim();
    }
    if ('definition' in body && body.definition !== undefined) {
      const check = validateScreenDefinition(body.definition);
      if (!check.ok) return sendAppError(reply, new AppError('GW-2005', { detail: check.detail }));
      patch.definition = check.definition;
    }
    if ('sortKey' in body) {
      patch.sortKey = typeof body.sortKey === 'string' ? body.sortKey : null;
    }
    if (patch.name === undefined && patch.definition === undefined && patch.sortKey === undefined) {
      return sendAppError(reply, new AppError('GW-2008', { detail: 'nothing to update' }));
    }

    const screen = await updateScreen(pool, session.userId, id, patch);
    if (!screen) return sendAppError(reply, new AppError('GW-2012'));
    return reply.send({ screen });
  });

  app.delete('/screens/:id', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };

    const ok = await deleteScreen(pool, session.userId, id);
    if (!ok) return sendAppError(reply, new AppError('GW-2012'));
    return reply.send({ ok: true });
  });
}
