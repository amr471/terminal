/**
 * Pure windowing math for the screener's virtualized table (P1.7 UI) — a
 * table backed by thousands of live-updating rows can't render every `<tr>`
 * (CLAUDE.md §6.1: "virtualized table for thousands of rows"). Rather than
 * pulling in a virtualization library, this follows the same house
 * convention resize.ts/panelOrder.ts already established: the windowing
 * arithmetic is a pure, node:test-testable function; the component
 * (ScreenerTable.tsx) only turns a scroll event into a call to it.
 *
 * Fixed row height only (no variable-height rows) — every screener row is
 * one line of mono-font numbers (Panel/NumCell's existing density model,
 * `--t-density-row`), so a fixed height covers the real use case without
 * the considerably harder variable-height windowing math.
 */
export interface VirtualRange {
  /** First row index to render (inclusive). */
  startIndex: number;
  /** Last row index to render (exclusive). */
  endIndex: number;
  /** Pixels to offset the rendered slice by (padding-top equivalent). */
  offsetY: number;
  /** Total scrollable height for all `rowCount` rows — sizes the scroll spacer. */
  totalHeight: number;
}

/**
 * Computes which rows are visible (plus `overscan` extra rows on each side,
 * so fast scrolling/keyboard nav doesn't flash blank rows before the next
 * paint) given the current scroll position and viewport size.
 */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan = 6,
): VirtualRange {
  const totalHeight = rowCount * rowHeight;
  if (rowCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 };
  }
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleCount = Math.ceil(viewportHeight / rowHeight);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(rowCount, firstVisible + visibleCount + overscan);
  return { startIndex, endIndex, offsetY: startIndex * rowHeight, totalHeight };
}
