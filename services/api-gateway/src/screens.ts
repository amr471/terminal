/**
 * Saved screens + built-in presets (P1.6). User screens live in the `screens`
 * table (single-writer: svc_api_gateway); presets are code-defined here rather
 * than seeded rows, so there's no migration to keep in sync and no admin
 * surface to build yet — `screens.is_preset` stays available for a future
 * DB-managed presets feature. A screen's `definition` is validated with
 * @terminal/types' validateFilterNode before it is ever stored or executed.
 */
import type { Pool } from 'pg';
import type { ScreenDefinition } from '@terminal/types';

export interface Screen {
  id: string;
  name: string;
  definition: ScreenDefinition;
  isPreset: boolean;
  sortKey: string | null;
}

/** Built-in presets (CLAUDE.md §6.1 examples). Ids are prefixed so they never
 * collide with the uuid ids of user screens. */
export const PRESETS: readonly Screen[] = [
  {
    id: 'preset:high-volume-losers',
    name: 'High-volume losers',
    isPreset: true,
    sortKey: 'volume_24h',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [
          { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '100000000' },
          { kind: 'numeric', field: 'change_24h', op: 'lt', value: '-0.05' },
        ],
      },
      sort: { field: 'volume_24h', dir: 'desc' },
    },
  },
  {
    id: 'preset:negative-funding',
    name: 'Negative funding',
    isPreset: true,
    sortKey: 'funding_rate',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [{ kind: 'numeric', field: 'funding_rate', op: 'lt', value: '0' }],
      },
      sort: { field: 'funding_rate', dir: 'asc' },
    },
  },
  {
    id: 'preset:unusual-oi',
    name: 'Unusual open interest',
    isPreset: true,
    sortKey: 'open_interest',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [{ kind: 'numeric', field: 'open_interest', op: 'gt', value: '0' }],
      },
      sort: { field: 'open_interest', dir: 'desc' },
      limit: 50,
    },
  },
  // Expanded 2026-07-26 (John: "we need more filters ... one-click presets").
  // Every preset carries `volume_24h > 0` so it can't surface dead or
  // not-yet-populated instruments — nulls never match, which is exactly the
  // behavior we want here (see docs/screener.md).
  {
    id: 'preset:top-gainers',
    name: 'Top gainers',
    isPreset: true,
    sortKey: 'change_24h',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [
          { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '1000000' },
          { kind: 'numeric', field: 'change_24h', op: 'gt', value: '0' },
        ],
      },
      sort: { field: 'change_24h', dir: 'desc' },
      limit: 50,
    },
  },
  {
    id: 'preset:top-losers',
    name: 'Top losers',
    isPreset: true,
    sortKey: 'change_24h',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [
          { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '1000000' },
          { kind: 'numeric', field: 'change_24h', op: 'lt', value: '0' },
        ],
      },
      sort: { field: 'change_24h', dir: 'asc' },
      limit: 50,
    },
  },
  {
    id: 'preset:most-active',
    name: 'Most active',
    isPreset: true,
    sortKey: 'volume_24h',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [{ kind: 'numeric', field: 'volume_24h', op: 'gt', value: '0' }],
      },
      sort: { field: 'volume_24h', dir: 'desc' },
      limit: 100,
    },
  },
  {
    id: 'preset:high-funding',
    name: 'High funding',
    isPreset: true,
    sortKey: 'funding_rate',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [
          { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '0' },
          // 0.0005 = 0.05% per interval — an elevated long-side crowding
          // signal, not a hard threshold; users can tune after applying.
          { kind: 'numeric', field: 'funding_rate', op: 'gt', value: '0.0005' },
        ],
      },
      sort: { field: 'funding_rate', dir: 'desc' },
      limit: 50,
    },
  },
  {
    id: 'preset:high-volatility',
    name: 'High volatility',
    isPreset: true,
    sortKey: 'volatility_24h',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [
          { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '1000000' },
          { kind: 'numeric', field: 'volatility_24h', op: 'gt', value: '0' },
        ],
      },
      sort: { field: 'volatility_24h', dir: 'desc' },
      limit: 50,
    },
  },
  {
    id: 'preset:wide-spread',
    name: 'Wide spread',
    isPreset: true,
    sortKey: 'spread',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [
          { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '0' },
          { kind: 'numeric', field: 'spread', op: 'gt', value: '0' },
        ],
      },
      sort: { field: 'spread', dir: 'desc' },
      limit: 50,
    },
  },
  {
    id: 'preset:big-movers',
    name: 'Big movers (±10%)',
    isPreset: true,
    sortKey: 'change_24h',
    definition: {
      version: 1,
      root: {
        kind: 'group',
        logic: 'and',
        children: [
          { kind: 'numeric', field: 'volume_24h', op: 'gt', value: '1000000' },
          // Exercises the OR branch and the `not between` idea via two arms:
          // anything outside ±10% on the day.
          {
            kind: 'group',
            logic: 'or',
            children: [
              { kind: 'numeric', field: 'change_24h', op: 'gt', value: '0.10' },
              { kind: 'numeric', field: 'change_24h', op: 'lt', value: '-0.10' },
            ],
          },
        ],
      },
      sort: { field: 'volume_24h', dir: 'desc' },
      limit: 100,
    },
  },
];

const PRESET_BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

interface ScreenRow {
  id: string;
  name: string;
  definition: ScreenDefinition;
  sort_key: string | null;
}

function toScreen(r: ScreenRow): Screen {
  return { id: r.id, name: r.name, definition: r.definition, isPreset: false, sortKey: r.sort_key };
}

/** Presets first, then the user's saved screens (newest last). */
export async function listScreens(pool: Pool, userId: string): Promise<Screen[]> {
  const { rows } = await pool.query<ScreenRow>(
    `SELECT id, name, definition, sort_key FROM screens
     WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [userId],
  );
  return [...PRESETS, ...rows.map(toScreen)];
}

/** Resolve a saved screen or preset id to its definition (for /screener/query
 * by id). Returns null if not found / not visible to this user. */
export async function getDefinition(
  pool: Pool,
  userId: string,
  id: string,
): Promise<ScreenDefinition | null> {
  const preset = PRESET_BY_ID.get(id);
  if (preset) return preset.definition;
  const { rows } = await pool.query<ScreenRow>(
    `SELECT id, name, definition, sort_key FROM screens
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0]?.definition ?? null;
}

export async function createScreen(
  pool: Pool,
  userId: string,
  name: string,
  definition: ScreenDefinition,
  sortKey?: string,
): Promise<Screen> {
  const { rows } = await pool.query<ScreenRow>(
    `INSERT INTO screens (user_id, name, definition, is_preset, sort_key)
     VALUES ($1, $2, $3, false, $4)
     RETURNING id, name, definition, sort_key`,
    [userId, name, JSON.stringify(definition), sortKey ?? null],
  );
  return toScreen(rows[0] as ScreenRow);
}

export async function updateScreen(
  pool: Pool,
  userId: string,
  id: string,
  patch: { name?: string; definition?: ScreenDefinition; sortKey?: string | null },
): Promise<Screen | null> {
  const { rows } = await pool.query<ScreenRow>(
    `UPDATE screens SET
       name       = COALESCE($3, name),
       definition = COALESCE($4, definition),
       sort_key   = CASE WHEN $5::boolean THEN $6 ELSE sort_key END,
       updated_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING id, name, definition, sort_key`,
    [
      id,
      userId,
      patch.name ?? null,
      patch.definition ? JSON.stringify(patch.definition) : null,
      patch.sortKey !== undefined,
      patch.sortKey ?? null,
    ],
  );
  return rows[0] ? toScreen(rows[0]) : null;
}

/** Soft-delete (schema keeps deleted_at for the screens_user_idx partial index). */
export async function deleteScreen(pool: Pool, userId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE screens SET deleted_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return (rowCount ?? 0) > 0;
}
