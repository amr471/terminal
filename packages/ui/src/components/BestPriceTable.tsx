'use client';

/**
 * Consolidated best-price table (P1.7b, CLAUDE.md §6.1's scalpboard.io-style
 * view): one row per symbol, the best bid/ask + top-of-book size across every
 * connected venue, live. Deliberately simpler than ScreenerTable (P1.7 UI):
 * no filter builder (bestPriceHub.ts has no per-subscriber definition — every
 * subscriber sees the same consolidated rows) and no column config (a fixed
 * column set for MVP; a follow-up if a configurable set is ever wanted).
 * Row order is dictated entirely by the server (tightest spread first,
 * bestPriceHub.ts's `sortRows`) — same "the live WS delta's order array is
 * the single source of truth" stance ScreenerTable takes, so there's no
 * sortable-column click handler here either.
 *
 * Reuses the `t-screener__*` CSS classes (terminal.css) rather than a
 * parallel `t-bestprice__*` set — both are virtualized `<table>`s with an
 * identical toolbar/scroll/row/cell structure inside the same package, so a
 * second copy of the same rules would just be upkeep for two names. Only
 * genuinely new visual elements (the venue badge) get their own class.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { bestPriceRowKey, type BestPriceRow, type Dec, type Locale } from '@terminal/types';
import { MarqueeText } from './MarqueeText.js';
import { NumCell } from './NumCell.js';
import { visibleRange } from '../virtualize.js';

export type BestPriceColumnId =
  | 'symbol'
  | 'bestBid'
  | 'bestBidSize'
  | 'bestBidVenue'
  | 'bestAsk'
  | 'bestAskSize'
  | 'bestAskVenue'
  | 'spread'
  | 'venueCount';

export const ALL_BEST_PRICE_COLUMNS: readonly BestPriceColumnId[] = [
  'symbol',
  'bestBidVenue',
  'bestBid',
  'bestBidSize',
  'bestAsk',
  'bestAskSize',
  'bestAskVenue',
  'spread',
  'venueCount',
];

// Fixed pixel widths so the browser doesn't recompute column widths from
// whichever rows happen to be mounted right now (auto table-layout measures
// only the DOM-present rows — with virtualization that's a ~20-row slice out
// of possibly hundreds, and symbol/venue string lengths vary a lot across
// that full set: 'btc' vs 'amdstockusdt', 'BYBIT' vs '—'). Without this,
// scrolling constantly swaps which rows are mounted, the browser reflows
// every column width to match, and rows can visually collapse/misalign mid-
// scroll ("the size changes... sometimes nothing is visible" — reported
// 2026-07-17). `symbol` deliberately has no fixed width: with
// `table-layout: fixed` a column left unset absorbs whatever space the
// others don't claim, so it's the one column allowed to flex.
//
// bestBidVenue/bestAskVenue are narrower than the other fixed columns
// (56, not 84) — per John's 2026-07-17 feedback that the venue badges made
// the table feel "folded," and the symbol is what he actually scans for.
// Venue names still fully readable on hover (MarqueeText); the column just
// no longer claims more width than a short badge needs at rest, so the
// symbol column (unset — the one that flexes) gets the reclaimed space.
const COLUMN_WIDTH_PX: Partial<Record<BestPriceColumnId, number>> = {
  bestBidVenue: 56,
  bestBid: 104,
  bestBidSize: 84,
  bestAsk: 104,
  bestAskSize: 84,
  bestAskVenue: 56,
  spread: 90,
  venueCount: 64,
};

function Cell({ id, row, locale }: { id: BestPriceColumnId; row: BestPriceRow; locale: Locale }): ReactNode {
  if (id === 'symbol') return <span className="t-screener__text">{row.symbol}</span>;
  if (id === 'bestBidVenue' || id === 'bestAskVenue') {
    const venue = row[id];
    return venue ? <span className="t-screener__venue">{venue}</span> : <span className="t-num t-num--empty">—</span>;
  }
  if (id === 'venueCount') return <span className="t-num">{row.venueCount}</span>;
  const value = row[id] as Dec | null;
  if (value === null) return <span className="t-num t-num--empty">—</span>;
  return <NumCell value={value} locale={locale} mode="plain" format={{ minFrac: 2 }} />;
}

export interface BestPriceTableProps {
  rows: BestPriceRow[];
  columns?: readonly BestPriceColumnId[];
  columnLabel: (id: BestPriceColumnId) => string;
  locale: Locale;
  emptyLabel: string;
  /** Defaults to `--t-density-row` (22px) — one line of mono-font data per row. */
  rowHeightPx?: number;
}

export function BestPriceTable({
  rows,
  columns = ALL_BEST_PRICE_COLUMNS,
  columnLabel,
  locale,
  emptyLabel,
  rowHeightPx = 22,
}: BestPriceTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setViewport({ height: el.clientHeight, scrollTop: el.scrollTop });
  }, []);

  const measureRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    if (!el) return;
    setViewport((v) => ({ ...v, height: el.clientHeight }));
    const observer = new ResizeObserver(() =>
      setViewport((v) => ({ ...v, height: el.clientHeight })),
    );
    observer.observe(el);
  }, []);

  const range = useMemo(
    () => visibleRange(viewport.scrollTop, viewport.height, rowHeightPx, rows.length),
    [viewport.scrollTop, viewport.height, rowHeightPx, rows.length],
  );

  const visibleRows = rows.slice(range.startIndex, range.endIndex);
  const belowHeight = Math.max(
    0,
    range.totalHeight - range.offsetY - visibleRows.length * rowHeightPx,
  );

  return (
    <div ref={measureRef} className="t-screener__scroll" onScroll={onScroll}>
      <table className="t-screener__table t-screener__table--fixed">
        <colgroup>
          {columns.map((id) => (
            <col key={id} style={COLUMN_WIDTH_PX[id] ? { width: COLUMN_WIDTH_PX[id] } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((id) => (
              <th key={id} scope="col" className="t-screener__th">
                {columnLabel(id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="t-screener__empty">
                {emptyLabel}
              </td>
            </tr>
          ) : (
            <>
              <tr aria-hidden="true" style={{ height: range.offsetY }}>
                <td colSpan={columns.length} style={{ padding: 0, border: 'none' }} />
              </tr>
              {visibleRows.map((row) => (
                <tr key={bestPriceRowKey(row)} className="t-screener__row" style={{ height: rowHeightPx }}>
                  {columns.map((id) => (
                    <td key={id} className="t-screener__td">
                      <MarqueeText>
                        <Cell id={id} row={row} locale={locale} />
                      </MarqueeText>
                    </td>
                  ))}
                </tr>
              ))}
              <tr aria-hidden="true" style={{ height: belowHeight }}>
                <td colSpan={columns.length} style={{ padding: 0, border: 'none' }} />
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}
