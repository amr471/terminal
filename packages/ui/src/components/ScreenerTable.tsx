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
 * Only real `ScreenerField`s are sortable — `symbol`/`exchange` are identity
 * columns the query engine's `ScreenDefinition.sort` doesn't support ordering
 * by (packages/types/src/screener.ts). That's a deliberate scope call: the
 * live WS delta's `order` array is the single source of truth for row order,
 * computed server-side by `runScreen`; a client-side-only sort on an
 * unsupported field would silently diverge from that order on the next
 * refresh.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  SCREENER_FIELDS,
  screenerRowKey,
  type Dec,
  type Locale,
  type ScreenerField,
  type ScreenerRow,
} from '@terminal/types';
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
const SORTABLE_FIELDS = new Set<string>(SCREENER_FIELDS);

// Fixed pixel widths — same rationale as BestPriceTable.tsx's
// COLUMN_WIDTH_PX (see that file's comment): `table-layout: auto` sizes
// columns from only the currently-mounted virtualized rows, so scrolling
// constantly reflows every column and can visibly collapse content
// ("the columns also move when you scroll down" — reported 2026-07-17
// against this table specifically). `symbol` is deliberately left unset so
// it absorbs whatever width the fixed columns don't claim. Column identity
// doesn't depend on display order, so this stays correct regardless of how
// the user has reordered/toggled columns via columnConfig.ts.
const COLUMN_WIDTH_PX: Partial<Record<ScreenerColumnId, number>> = {
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

function isSortable(id: ScreenerColumnId): id is ScreenerField {
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
  if (id === 'symbol' || id === 'exchange')
    return <span className="t-screener__text">{value}</span>;
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
  sort?: { field: ScreenerField; dir: 'asc' | 'desc' };
  onSortChange: (field: ScreenerField) => void;
  emptyLabel: string;
  /** Defaults to `--t-density-row` (22px) — one line of mono-font data per row. */
  rowHeightPx?: number;
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
                  className="t-screener__row"
                  style={{ height: rowHeightPx }}
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
