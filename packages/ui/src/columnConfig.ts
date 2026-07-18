/**
 * Screener column configuration (P1.7 UI: CLAUDE.md §6.1's "column config").
 * Pure list ops only — same split as tabOrder.ts (apps/web) uses for the tab
 * strip: `packages/ui` owns the presentational table, but doesn't own
 * *where* a column list is persisted (apps/web's ScreenerPanel does that,
 * to `localStorage`, same scope call P1.4a's SecondaryClock made for a
 * personal per-browser display preference — see docs/screener-ui.md).
 */
import type { ScreenerField } from '@terminal/types';

/** Every column the table can show: the two identity columns plus every
 * screener field the query engine evaluates (@terminal/types' SCREENER_FIELDS). */
export type ScreenerColumnId = 'symbol' | 'exchange' | ScreenerField;

export const ALL_SCREENER_COLUMNS: readonly ScreenerColumnId[] = [
  'symbol',
  'exchange',
  'price',
  'change_1h',
  'change_24h',
  'change_7d',
  'volume_24h',
  'market_cap',
  'open_interest',
  'funding_rate',
  'volatility_24h',
  'spread',
];

/** A dense-but-not-overwhelming starting set (CLAUDE.md §5: "refined, not
 * cluttered") — the rest are one click away in column config, not hidden
 * behind a settings page. */
export const DEFAULT_VISIBLE_COLUMNS: readonly ScreenerColumnId[] = [
  'symbol',
  'exchange',
  'price',
  'change_24h',
  'volume_24h',
  'funding_rate',
  'open_interest',
];

/** Toggles `id` in/out of `visible`, preserving the existing order for
 * everything else and appending newly-shown columns at the end. Refuses
 * (no-op) to hide the last remaining column — a table with zero columns
 * isn't a recoverable state from the UI, same reject-rather-than-clamp
 * stance resizeTracks/movePanel already take at their own floors. */
export function toggleColumn(
  visible: readonly ScreenerColumnId[],
  id: ScreenerColumnId,
): ScreenerColumnId[] {
  if (visible.includes(id)) {
    if (visible.length <= 1) return [...visible];
    return visible.filter((c) => c !== id);
  }
  return [...visible, id];
}

/** Moves `id` to `targetIndex` within `visible` (index into the
 * post-removal array, same convention apps/web's `reorderTo` uses for tabs).
 * Unknown id or already-there is a no-op (fresh array, same order). */
export function reorderColumn(
  visible: readonly ScreenerColumnId[],
  id: ScreenerColumnId,
  targetIndex: number,
): ScreenerColumnId[] {
  const current = visible.indexOf(id);
  if (current < 0) return [...visible];
  const without = visible.filter((c) => c !== id);
  const clamped = Math.max(0, Math.min(targetIndex, without.length));
  const next = [...without];
  next.splice(clamped, 0, id);
  return next;
}
