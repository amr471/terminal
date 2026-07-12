/**
 * Saved terminal layout persistence (`layouts` table, migration 0002).
 * P1.3 scope: one layout per user, always named 'default' and always
 * `is_default = true` — the terminal shell only ever needs "the user's
 * current workspace," not a named-layout management UI (switching between
 * multiple saved layouts is a real future feature, not needed yet). All
 * queries are parameterized (trading-security / senior-backend baseline).
 */
import type pg from 'pg';
import type { LayoutDefinition } from '@terminal/types';

const DEFAULT_LAYOUT_NAME = 'default';

export async function getDefaultLayout(
  db: pg.Pool,
  userId: string,
): Promise<LayoutDefinition | null> {
  const res = await db.query<{ definition: LayoutDefinition }>(
    `SELECT definition FROM layouts WHERE user_id = $1 AND is_default = true LIMIT 1`,
    [userId],
  );
  return res.rows[0]?.definition ?? null;
}

/** Creates or overwrites the user's one default layout. */
export async function saveDefaultLayout(
  db: pg.Pool,
  userId: string,
  definition: LayoutDefinition,
): Promise<void> {
  await db.query(
    `INSERT INTO layouts (user_id, name, definition, is_default)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (user_id, name)
     DO UPDATE SET definition = $3, is_default = true, updated_at = now()`,
    [userId, DEFAULT_LAYOUT_NAME, JSON.stringify(definition)],
  );
}
