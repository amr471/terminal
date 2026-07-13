/**
 * Saved terminal workspace tabs (`layouts` table, migration 0004 — P1.3a).
 * Each row is one tab: a server-generated internal `name`, a user-facing
 * `title`, a `sort_order` for the tab strip, an `is_active` flag (exactly
 * one true per user, enforced by a partial unique index), and the saved
 * panel-grid `definition`. Replaces P1.3's "always exactly one layout named
 * 'default'" model — this is that model generalized to N tabs. Multi-step
 * operations (create/activate/reorder/delete all touch `is_active` or
 * `sort_order` across more than one row) run inside a transaction, same
 * `pool.connect()` + BEGIN/COMMIT/ROLLBACK pattern as users.ts's
 * `linkOrCreateOAuthUser`.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  defaultLayoutDefinition,
  MAX_TABS_PER_USER,
  type LayoutDefinition,
  type TerminalTabSummary,
} from '@terminal/types';

interface TabRow {
  id: string;
  title: string;
  sort_order: number;
  is_active: boolean;
  definition: LayoutDefinition;
}

function toSummary(row: TabRow): TerminalTabSummary {
  return {
    id: row.id,
    title: row.title,
    order: row.sort_order,
    isActive: row.is_active,
    definition: row.definition,
  };
}

export async function listTabs(db: pg.Pool, userId: string): Promise<TerminalTabSummary[]> {
  const res = await db.query<TabRow>(
    `SELECT id, title, sort_order, is_active, definition
     FROM layouts WHERE user_id = $1 ORDER BY sort_order ASC, created_at ASC`,
    [userId],
  );
  return res.rows.map(toSummary);
}

export type CreateTabResult =
  { result: 'ok'; tab: TerminalTabSummary } | { result: 'limit_reached' };

/** Creates a new tab and activates it — opening a tab switches to it. */
export async function createTab(
  db: pg.Pool,
  userId: string,
  title: string,
  definition: LayoutDefinition = defaultLayoutDefinition(),
): Promise<CreateTabResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM layouts WHERE user_id = $1`,
      [userId],
    );
    if (Number(countRes.rows[0]?.count ?? '0') >= MAX_TABS_PER_USER) {
      await client.query('ROLLBACK');
      return { result: 'limit_reached' };
    }

    const maxOrderRes = await client.query<{ max: number | null }>(
      `SELECT MAX(sort_order) AS max FROM layouts WHERE user_id = $1`,
      [userId],
    );
    const nextOrder = (maxOrderRes.rows[0]?.max ?? -1) + 1;

    await client.query(`UPDATE layouts SET is_active = false WHERE user_id = $1`, [userId]);
    const inserted = await client.query<TabRow>(
      `INSERT INTO layouts (user_id, name, title, definition, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, title, sort_order, is_active, definition`,
      [userId, `tab-${randomUUID()}`, title, JSON.stringify(definition), nextOrder],
    );
    await client.query('COMMIT');

    const row = inserted.rows[0];
    if (!row) throw new Error('tab insert returned no row');
    return { result: 'ok', tab: toSummary(row) };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Partial update (title and/or definition). Returns null if not found/not owned. */
export async function updateTab(
  db: pg.Pool,
  userId: string,
  tabId: string,
  patch: { title?: string; definition?: LayoutDefinition },
): Promise<TerminalTabSummary | null> {
  const res = await db.query<TabRow>(
    `UPDATE layouts
     SET title = COALESCE($3, title),
         definition = COALESCE($4, definition),
         updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING id, title, sort_order, is_active, definition`,
    [
      tabId,
      userId,
      patch.title ?? null,
      patch.definition ? JSON.stringify(patch.definition) : null,
    ],
  );
  const row = res.rows[0];
  return row ? toSummary(row) : null;
}

/** Returns false if the tab doesn't exist or isn't owned by this user. */
export async function activateTab(db: pg.Pool, userId: string, tabId: string): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const owns = await client.query(`SELECT 1 FROM layouts WHERE id = $1 AND user_id = $2`, [
      tabId,
      userId,
    ]);
    if (owns.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(`UPDATE layouts SET is_active = false WHERE user_id = $1`, [userId]);
    await client.query(`UPDATE layouts SET is_active = true, updated_at = now() WHERE id = $1`, [
      tabId,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reorders every tab to match `orderedIds`. Rejects (returns false, no
 * partial write) unless `orderedIds` is exactly the user's current tab-id
 * set with no duplicates — a subset/superset/foreign-id list is hostile
 * input, same "reject rather than partial-clamp" stance as resize.ts.
 */
export async function reorderTabs(
  db: pg.Pool,
  userId: string,
  orderedIds: string[],
): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ id: string }>(
      `SELECT id FROM layouts WHERE user_id = $1`,
      [userId],
    );
    const currentIds = new Set(current.rows.map((r) => r.id));
    const sameSet =
      orderedIds.length === currentIds.size &&
      new Set(orderedIds).size === orderedIds.length &&
      orderedIds.every((id) => currentIds.has(id));
    if (!sameSet) {
      await client.query('ROLLBACK');
      return false;
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        `UPDATE layouts SET sort_order = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
        [orderedIds[i], userId, i],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type DeleteTabResult = 'ok' | 'not_found' | 'last_tab';

/**
 * Deletes a tab. Refuses to delete a user's last remaining tab (`last_tab`
 * — the terminal shell always needs at least one). If the deleted tab was
 * active, activates the remaining tab with the smallest `sort_order` so the
 * shell always has a well-defined tab to show next.
 */
export async function deleteTab(
  db: pg.Pool,
  userId: string,
  tabId: string,
): Promise<{ result: DeleteTabResult; activeTabId?: string | undefined }> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const all = await client.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active FROM layouts WHERE user_id = $1 ORDER BY sort_order ASC`,
      [userId],
    );
    const target = all.rows.find((r) => r.id === tabId);
    if (!target) {
      await client.query('ROLLBACK');
      return { result: 'not_found' };
    }
    if (all.rows.length <= 1) {
      await client.query('ROLLBACK');
      return { result: 'last_tab' };
    }

    await client.query(`DELETE FROM layouts WHERE id = $1 AND user_id = $2`, [tabId, userId]);

    let activeTabId: string | undefined;
    if (target.is_active) {
      const next = all.rows.find((r) => r.id !== tabId);
      if (next) {
        await client.query(
          `UPDATE layouts SET is_active = true, updated_at = now() WHERE id = $1`,
          [next.id],
        );
        activeTabId = next.id;
      }
    }
    await client.query('COMMIT');
    return { result: 'ok', activeTabId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
