/**
 * /layouts/tabs — the terminal shell's browser-style workspace tabs (P1.3a,
 * generalizing P1.3's single default layout to N named, orderable, closable
 * tabs). Structural validation of each tab's panel-grid definition still
 * delegates to @terminal/types' validateLayoutDefinition — same
 * single-source-of-truth pattern as P1.3; title validation is small enough
 * to share via @terminal/types' isValidTabTitle instead of a parallel zod
 * schema.
 */
import type { FastifyInstance } from 'fastify';
import { validateLayoutDefinition, isValidTabTitle, type LayoutDefinition } from '@terminal/types';
import { requireSession } from './sessionAuth.js';
import { AppError, sendAppError } from './errors.js';
import { listTabs, createTab, updateTab, activateTab, reorderTabs, deleteTab } from './layouts.js';
import { pool } from './db.js';

/** The title given to a lazily-provisioned first tab (see GET /layouts/tabs
 * below) — matches migration 0004's backfill value for pre-existing
 * single-layout users, so old and new accounts land on the same label. */
const FIRST_TAB_TITLE = 'Main';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateDefinitionField(
  body: Record<string, unknown>,
): { ok: true; definition: LayoutDefinition | undefined } | { ok: false; detail: string } {
  if (!('definition' in body) || body.definition === undefined)
    return { ok: true, definition: undefined };
  const errors = validateLayoutDefinition(body.definition);
  if (errors.length > 0) return { ok: false, detail: errors[0] ?? 'invalid' };
  return { ok: true, definition: body.definition as LayoutDefinition };
}

export function registerLayoutRoutes(app: FastifyInstance): void {
  app.get('/layouts/tabs', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    let tabs = await listTabs(pool, session.userId);
    if (tabs.length === 0) {
      // Brand-new user, or a user whose tabs were somehow all deleted —
      // the shell always needs at least one tab to show.
      const created = await createTab(pool, session.userId, FIRST_TAB_TITLE);
      if (created.result === 'ok') tabs = [created.tab];
    }
    return reply.send({ tabs });
  });

  app.post('/layouts/tabs', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const body = request.body;
    if (!isPlainObject(body) || !isValidTabTitle(body.title)) {
      return sendAppError(reply, new AppError('GW-2008'));
    }
    const parsedDefinition = validateDefinitionField(body);
    if (!parsedDefinition.ok) {
      return sendAppError(reply, new AppError('GW-2010', { detail: parsedDefinition.detail }));
    }

    const created = await createTab(pool, session.userId, body.title, parsedDefinition.definition);
    if (created.result === 'limit_reached') {
      return sendAppError(reply, new AppError('GW-2013'));
    }
    return reply.code(201).send({ tab: created.tab });
  });

  // Registered before the parametric `/layouts/tabs/:id` routes for
  // readability; Fastify's router matches static segments ahead of
  // parametric ones regardless of registration order, so this ordering
  // isn't load-bearing, just clearer to read top-to-bottom.
  app.put('/layouts/tabs/reorder', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;

    const body = request.body;
    if (
      !isPlainObject(body) ||
      !Array.isArray(body.order) ||
      !body.order.every((id) => typeof id === 'string')
    ) {
      return sendAppError(reply, new AppError('GW-2008'));
    }

    const ok = await reorderTabs(pool, session.userId, body.order as string[]);
    if (!ok) {
      return sendAppError(
        reply,
        new AppError('GW-2008', { detail: 'order must match the user’s existing tabs' }),
      );
    }
    return reply.send({ ok: true });
  });

  app.put('/layouts/tabs/:id/activate', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };

    const ok = await activateTab(pool, session.userId, id);
    if (!ok) return sendAppError(reply, new AppError('GW-2012'));
    return reply.send({ ok: true });
  });

  app.put('/layouts/tabs/:id', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };

    const body = request.body;
    if (!isPlainObject(body)) {
      return sendAppError(reply, new AppError('GW-2008'));
    }

    const patch: { title?: string; definition?: LayoutDefinition } = {};
    if ('title' in body && body.title !== undefined) {
      if (!isValidTabTitle(body.title)) return sendAppError(reply, new AppError('GW-2008'));
      patch.title = body.title;
    }
    const parsedDefinition = validateDefinitionField(body);
    if (!parsedDefinition.ok) {
      return sendAppError(reply, new AppError('GW-2010', { detail: parsedDefinition.detail }));
    }
    // Only assign when present — exactOptionalPropertyTypes distinguishes
    // "property absent" from "property explicitly set to undefined," and
    // `patch`'s optional fields mean absent (see errors.ts's AppError.details
    // for the same explicit-undefined-vs-absent convention elsewhere).
    if (parsedDefinition.definition !== undefined) patch.definition = parsedDefinition.definition;

    if (patch.title === undefined && patch.definition === undefined) {
      return sendAppError(reply, new AppError('GW-2008', { detail: 'nothing to update' }));
    }

    const tab = await updateTab(pool, session.userId, id, patch);
    if (!tab) return sendAppError(reply, new AppError('GW-2012'));
    return reply.send({ tab });
  });

  app.delete('/layouts/tabs/:id', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const { id } = request.params as { id: string };

    const outcome = await deleteTab(pool, session.userId, id);
    if (outcome.result === 'not_found') return sendAppError(reply, new AppError('GW-2012'));
    if (outcome.result === 'last_tab') return sendAppError(reply, new AppError('GW-2011'));
    return reply.send({ ok: true, activeTabId: outcome.activeTabId });
  });
}
