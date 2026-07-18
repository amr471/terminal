/**
 * CSV export for the screener's visible rows (CLAUDE.md §6.1: "Export with
 * watermark/referral link (growth mechanic)"). Pure string-building, no DOM
 * (the caller wires the resulting text to a download via a Blob + <a>,
 * apps/web-only, not unit-tested per this repo's DOM-free-tests convention).
 *
 * Scope call: values are exported as the raw `Dec` strings the engine
 * produces, not locale-formatted display text (`formatDec` etc.) — a CSV
 * meant to be reopened in a spreadsheet should be exact and locale-agnostic;
 * inserting e.g. Russian `,` decimal separators or thousands grouping would
 * make the numbers ambiguous or outright break re-import. Display formatting
 * stays a screen-only concern (ScreenerTable's NumCell).
 *
 * Scope call: no per-user referral code system exists yet (checked
 * docs/schema.md — nothing reserved for it), so the watermark links to the
 * site origin rather than a personalized `/r/<code>` link. Swapping in a
 * real referral code later is a caller-side change (the `referralUrl` this
 * takes), not a change to the CSV shape itself.
 */
import type { ScreenerRow } from '@terminal/types';
import type { ScreenerColumnId } from '@terminal/ui';

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cellText(row: ScreenerRow, id: ScreenerColumnId): string {
  if (id === 'symbol') return row.symbol;
  if (id === 'exchange') return row.exchange;
  const value = row[id];
  return value === null ? '' : value;
}

/**
 * Builds CSV text: a header row (translated column labels), one row per
 * screener row, a blank separator row, then the watermark line — the
 * blank row keeps the watermark from being misread as a data row by a
 * naive CSV importer that assumes every row has the same column count.
 */
export function screenerRowsToCsv(
  rows: readonly ScreenerRow[],
  columns: readonly ScreenerColumnId[],
  columnLabel: (id: ScreenerColumnId) => string,
  watermarkLine: string,
): string {
  const header = columns.map((id) => csvField(columnLabel(id))).join(',');
  const dataLines = rows.map((row) => columns.map((id) => csvField(cellText(row, id))).join(','));
  return [header, ...dataLines, '', csvField(watermarkLine)].join('\n');
}

/** `terminal-screener-2026-07-16.csv` — sortable, collision-resistant enough
 * for a manual download (a same-day re-export just overwrites, which is
 * the expected/desired behavior for "export what I'm looking at right now"). */
export function screenerExportFilename(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `terminal-screener-${y}-${m}-${d}.csv`;
}
