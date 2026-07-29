'use client';

/**
 * Virtualized, sortable screener table (P1.7 UI, CLAUDE.md §6.1). Presentational
 * and controlled, same boundary TabBar/ResizableColumns already draw: rows,
 * visible columns, and sort state are all props; every mutation (sort click,
 * column config) is a callback out to the caller (apps/web's ScreenerPanel),
 * which owns the live WS subscription and the localStorage-persisted column
 * list (packages/ui must not depend on apps/web).
 *
 * Windowing is real `<table>` markup (not a div-grid) so screen readers still
 * see a table: a measured-height scroll container, `visibleRange` (virtualize.ts)
 * picks which data rows actually mount, and two single-cell spacer `<tr>`s
 * absorb the height of everything scrolled past above/below — the same
 * "spacer rows" technique used before dedicated virtualization libraries
 * existed, and consistent with this repo's own pure-math-plus-thin-component
 * convention (no new dependency, same reasoning ResizableColumns/TabBar used).
 *
 * Only fields the query engine's `ScreenDefinition.sort` supports ordering by
 * are sortable — every `ScreenerField` plus `symbol` (`SCREENER_SORT_FIELDS`,
 * packages/types/src/screener.ts; `symbol` joined 2026-07-19 for an
 * alphabetical view). `exchange` still isn't — it's categorical, no ordering
 * defined. That's a deliberate scope call: the live WS delta's `order` array
 * is the single source of truth for row order, computed server-side by
 * `runScreen`; a client-side-only sort on an unsupported field would
 * silently diverge from that order on the next refresh.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  SCREENER_SORT_FIELDS,
  exchangeTradeUrl,
  screenerRowKey,
  type Dec,
  type Locale,
  type ScreenerSortField,
  type ScreenerRow,
} from '@terminal/types';
import { t } from '@terminal/i18n';
import { MarqueeText } from './MarqueeText.js';
import { NumCell } from './NumCell.js';
import { visibleRange } from '../virtualize.js';
import type { ScreenerColumnId } from '../columnConfig.js';

const PERCENT_FIELDS = new Set<ScreenerColumnId>([
  'change_1h',
  'change_24h',
  'change_7d',
  'funding_rate',
]);
// 'symbol' joined the sortable set 2026-07-19 (alphabetical view) —
// SCREENER_SORT_FIELDS is ScreenerFields + 'symbol', 'exchange' still isn't
// sortable (categorical, no ordering the query engine defines).
const SORTABLE_FIELDS = new Set<string>(SCREENER_SORT_FIELDS);

// Fixed pixel widths — same rationale as BestPriceTable.tsx's
// COLUMN_WIDTH_PX (see that file's comment): `table-layout: auto` sizes
// columns from only the currently-mounted virtualized rows, so scrolling
// constantly reflows every column and can visibly collapse content
// ("the columns also move when you scroll down" — reported 2026-07-17
// against this table specifically).
//
// `symbol` used to be deliberately left unset so it could absorb whatever
// width the fixed columns didn't claim — but `table-layout: fixed` only
// grows the *table* to fit the fixed columns; an unset column just gets
// whatever's left over, which is nothing once a narrow panel's fixed
// columns already add up to more than the panel is wide. Real bug found
// 2026-07-18: in a narrowed 3-column workspace, `symbol` was rendering at
// ~0px — genuinely invisible, not just scrolled out of view ("the names of
// the coins are not visible, even when I move the gesture to the right and
// left"). Fixed by giving `symbol` a real width like every other column,
// plus making it a sticky-left first column (terminal.css) so it stays
// visible while the metric columns scroll underneath it — the identity
// column should never be the one that gets squeezed out.
const COLUMN_WIDTH_PX: Partial<Record<ScreenerColumnId, number>> = {
  symbol: 120,
  exchange: 90,
  price: 110,
  change_1h: 76,
  change_24h: 76,
  change_7d: 76,
  volume_24h: 110,
  market_cap: 110,
  open_interest: 110,
  funding_rate: 92,
  volatility_24h: 92,
  spread: 90,
};

function isSortable(id: ScreenerColumnId): id is ScreenerSortField {
  return SORTABLE_FIELDS.has(id);
}

function cellValue(row: ScreenerRow, id: ScreenerColumnId): Dec | string | null {
  if (id === 'symbol') return row.symbol;
  if (id === 'exchange') return row.exchange;
  return row[id];
}

function Cell({
  id,
  row,
  locale,
}: {
  id: ScreenerColumnId;
  row: ScreenerRow;
  locale: Locale;
}): ReactNode {
  const value = cellValue(row, id);
  if (value === null) return <span className="t-num t-num--empty">—</span>;
  if (id === 'exchange') {
    // 2026-07-18: the exchange badge links out to that venue's real trading
    // page for this row's symbol (docs/screener-ui.md) — separate from a
    // row click, which opens our internal cross-venue detail tab
    // (onSymbolClick below), so clicks here must stopPropagation. Falls
    // back to plain text for a venue exchangeTradeUrl doesn't recognize.
    const url = exchangeTradeUrl(String(value), row.symbol);
    if (!url) return <span className="t-screener__text">{value}</span>;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="t-screener__text t-screener__venue--link"
        title={t(locale, 'common.open_on_exchange', { symbol: row.symbol, exchange: String(value) })}
        onClick={(e) => e.stopPropagation()}
      >
        {value}
      </a>
    );
  }
  if (id === 'symbol') return <span className="t-screener__text">{value}</span>;
  return (
    <NumCell
      value={value}
      locale={locale}
      mode={PERCENT_FIELDS.has(id) ? 'percent' : 'plain'}
      directional={PERCENT_FIELDS.has(id)}
      format={id === 'price' ? { minFrac: 2 } : {}}
    />
  );
}

export interface ScreenerTableProps {
  rows: ScreenerRow[];
  /** Visible columns, in display order (apps/web's columnConfig.ts owns persistence). */
  columns: readonly ScreenerColumnId[];
  columnLabel: (id: ScreenerColumnId) => string;
  locale: Locale;
  sort?: { field: ScreenerSortField; dir: 'asc' | 'desc' };
  onSortChange: (field: ScreenerSortField) => void;
  emptyLabel: string;
  /** Defaults to `--t-density-row` (22px) — one line of mono-font data per row. */
  rowHeightPx?: number;
  /**
   * Added 2026-07-18 for the Screener-row-click detail view
   * (docs/best-price.md): when set, rows become clickable (and keyboard-
   * activatable) and call back with the row's symbol. Omitted keeps rows
   * inert, same as before.
   */
  onSymbolClick?: (symbol: string) => void;
}

export function ScreenerTable({
  rows,
  columns,
  columnLabel,
  locale,
  sort,
  onSortChange,
  emptyLabel,
  rowHeightPx = 22,
  onSymbolClick,
}: ScreenerTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 });

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setViewport({ height: el.clientHeight, scrollTop: el.scrollTop });
  }, []);

  // Measure the scroll container once mounted and whenever it resizes — the
  // panel it lives in is itself resizable (ResizableColumns), so a fixed
  // height prop would go stale the moment the user drags a handle.
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
            {columns.map((id) => {
              const sortable = isSortable(id);
              const active = sortable && sort?.field === id;
              const ariaSort = active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none';
              return (
                <th
                  key={id}
                  scope="col"
                  aria-sort={sortable ? ariaSort : undefined}
                  className="t-screener__th"
                >
                  {sortable ? (
                    <button
                      type="button"
                      className={`t-screener__sort${active ? ' t-screener__sort--active' : ''}`}
                      onClick={() => onSortChange(id)}
                    >
                      {columnLabel(id)}
                      {active && (
                        <span className="t-screener__sort-arrow">
                          {sort!.dir === 'asc' ? '▲' : '▼'}
                        </span>
                      )}
                    </button>
                  ) : (
                    columnLabel(id)
                  )}
                </th>
              );
            })}
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
                <tr
                  key={screenerRowKey(row)}
                  className={`t-screener__row${onSymbolClick ? ' t-screener__row--clickable' : ''}`}
                  style={{ height: rowHeightPx }}
                  {...(onSymbolClick
                    ? {
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => onSymbolClick(row.symbol),
                        onKeyDown: (e: KeyboardEvent) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSymbolClick(row.symbol);
                          }
                        },
                      }
                    : {})}
                >
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
