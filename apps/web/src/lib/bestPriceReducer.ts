/**
 * Pure reducer applying live best-price WS frames (P1.7b's `bestprice.snapshot`/
 * `bestprice.delta`, packages/types/src/bestPrice.ts) to a row-order + row-map
 * state — same split screenerReducer.ts uses (pure logic gets its own
 * node:test tests, the impure socket/hook glue doesn't). Rows here are
 * keyed by bare `symbol` (bestPriceRowKey), not `exchange|symbol` — this
 * view is already consolidated across venues.
 */
import {
  bestPriceRowKey,
  type BestPriceDeltaFrame,
  type BestPriceRow,
  type BestPriceSnapshotFrame,
} from '@terminal/types';

export interface BestPriceTableState {
  /** Row order, by `symbol` — mirrors the gateway's own order (tightest
   * spread first), never re-sorted client-side. */
  order: readonly string[];
  byKey: Readonly<Record<string, BestPriceRow>>;
}

export const EMPTY_BEST_PRICE_STATE: BestPriceTableState = { order: [], byKey: {} };

/** Applies one snapshot or delta frame, producing the next state — same
 * semantics as applyScreenerFrame: a snapshot always replaces state outright
 * (sent once, on subscribe); a delta merges added/updated, drops removed,
 * and adopts the frame's `order` verbatim. */
export function applyBestPriceFrame(
  state: BestPriceTableState,
  frame: BestPriceSnapshotFrame | BestPriceDeltaFrame,
): BestPriceTableState {
  if (frame.type === 'bestprice.snapshot') {
    const byKey: Record<string, BestPriceRow> = {};
    for (const row of frame.rows) byKey[bestPriceRowKey(row)] = row;
    return { order: frame.rows.map(bestPriceRowKey), byKey };
  }
  const byKey = { ...state.byKey };
  for (const row of frame.added) byKey[bestPriceRowKey(row)] = row;
  for (const row of frame.updated) byKey[bestPriceRowKey(row)] = row;
  for (const key of frame.removed) delete byKey[key];
  return { order: frame.order, byKey };
}

/** Materializes the ordered row array a table actually renders. A key
 * present in `order` but missing from `byKey` (a transient race between two
 * frames) is skipped rather than rendered as a hole. */
export function bestPriceStateRows(state: BestPriceTableState): BestPriceRow[] {
  const rows: BestPriceRow[] = [];
  for (const key of state.order) {
    const row = state.byKey[key];
    if (row) rows.push(row);
  }
  return rows;
}
