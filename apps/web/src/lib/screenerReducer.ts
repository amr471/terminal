/**
 * Pure reducer applying live screener WS frames (P1.6's `screener.snapshot`/
 * `screener.delta`, packages/types/src/screener.ts) to a row-order + row-map
 * state — kept free of the WS client itself so it's directly node:test-
 * testable, same split gatewaySocket.ts's `backoffDelayMs`/`gatewayWsUrl`
 * follow (repo convention: pure logic gets its own tests, the impure
 * socket/hook glue doesn't, since there's no jsdom/WS environment here).
 */
import {
  screenerRowKey,
  type ScreenerDeltaFrame,
  type ScreenerRow,
  type ScreenerSnapshotFrame,
} from '@terminal/types';

export interface ScreenerTableState {
  /** Row order, by `exchange|symbol` key — mirrors the gateway's own order,
   * never re-sorted client-side (see ScreenerTable.tsx's sortable-columns note). */
  order: readonly string[];
  byKey: Readonly<Record<string, ScreenerRow>>;
}

export const EMPTY_SCREENER_STATE: ScreenerTableState = { order: [], byKey: {} };

/** Applies one snapshot or delta frame, producing the next state. A snapshot
 * always replaces the state outright (docs/screener.md: sent once, on
 * subscribe); a delta merges added/updated into `byKey`, drops `removed`,
 * and adopts the frame's `order` verbatim (the hub already computed it). */
export function applyScreenerFrame(
  state: ScreenerTableState,
  frame: ScreenerSnapshotFrame | ScreenerDeltaFrame,
): ScreenerTableState {
  if (frame.type === 'screener.snapshot') {
    const byKey: Record<string, ScreenerRow> = {};
    for (const row of frame.rows) byKey[screenerRowKey(row)] = row;
    return { order: frame.rows.map(screenerRowKey), byKey };
  }
  const byKey = { ...state.byKey };
  for (const row of frame.added) byKey[screenerRowKey(row)] = row;
  for (const row of frame.updated) byKey[screenerRowKey(row)] = row;
  for (const key of frame.removed) delete byKey[key];
  return { order: frame.order, byKey };
}

/** Materializes the ordered row array a table actually renders. A key present
 * in `order` but missing from `byKey` (a transient race between two frames)
 * is skipped rather than rendered as a hole. */
export function screenerStateRows(state: ScreenerTableState): ScreenerRow[] {
  const rows: ScreenerRow[] = [];
  for (const key of state.order) {
    const row = state.byKey[key];
    if (row) rows.push(row);
  }
  return rows;
}
