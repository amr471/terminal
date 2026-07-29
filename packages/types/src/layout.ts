/**
 * Terminal shell layout model (CLAUDE.md §5, P1.3): saved workspace grid
 * state (`layouts.definition` JSONB). Deliberately simpler than a fully
 * general N×M dockable grid — columns side by side, each column an
 * independent stack of panels. That covers "resizable, saveable, default
 * view = screener + chart + news" without needing arbitrary drag-and-drop
 * panel rearrangement (out of scope for P1.3; a future task if wanted).
 *
 * Every track size is in fr units (CSS grid fractional units) — resizing
 * just redistributes fr between adjacent tracks, never touches pixels
 * server-side.
 */

export const TERMINAL_PANEL_KINDS = ['screener', 'chart', 'news', 'bestprice'] as const;
export type TerminalPanelKind = (typeof TERMINAL_PANEL_KINDS)[number];

export interface LayoutPanelSlot {
  kind: TerminalPanelKind;
  /** This panel's share of its column's vertical space, in fr units. */
  size: number;
}

export interface LayoutColumn {
  /** This column's share of the grid's horizontal space, in fr units. */
  size: number;
  /** Stacked top-to-bottom within the column. */
  panels: LayoutPanelSlot[];
}

/** A saved terminal layout (`layouts.definition` JSONB). */
export interface LayoutDefinition {
  version: 1;
  columns: LayoutColumn[];
}

export const MAX_LAYOUT_COLUMNS = 6;
export const MAX_PANELS_PER_COLUMN = 6;
export const MIN_TRACK_SIZE_FR = 0.2;

/**
 * Structural validation with size limits (defense against hostile or
 * malformed definitions) — same shape as `validateFilterNode` in
 * screener.ts. Returns a list of problems; empty = valid.
 */
export function validateLayoutDefinition(def: unknown): string[] {
  const errors: string[] = [];
  if (typeof def !== 'object' || def === null) return ['definition is not an object'];
  const d = def as Record<string, unknown>;

  if (d.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(d.columns) || d.columns.length === 0) {
    return [...errors, 'columns must be a non-empty array'];
  }
  if (d.columns.length > MAX_LAYOUT_COLUMNS) {
    errors.push(`too many columns (max ${MAX_LAYOUT_COLUMNS})`);
  }

  d.columns.forEach((col, colIndex) => {
    if (typeof col !== 'object' || col === null) {
      errors.push(`columns[${colIndex}] is not an object`);
      return;
    }
    const c = col as Record<string, unknown>;
    if (typeof c.size !== 'number' || !Number.isFinite(c.size) || c.size < MIN_TRACK_SIZE_FR) {
      errors.push(`columns[${colIndex}].size must be a number >= ${MIN_TRACK_SIZE_FR}`);
    }
    if (!Array.isArray(c.panels) || c.panels.length === 0) {
      errors.push(`columns[${colIndex}].panels must be a non-empty array`);
      return;
    }
    if (c.panels.length > MAX_PANELS_PER_COLUMN) {
      errors.push(`columns[${colIndex}].panels: too many panels (max ${MAX_PANELS_PER_COLUMN})`);
    }
    c.panels.forEach((panel, panelIndex) => {
      if (typeof panel !== 'object' || panel === null) {
        errors.push(`columns[${colIndex}].panels[${panelIndex}] is not an object`);
        return;
      }
      const p = panel as Record<string, unknown>;
      if (!(TERMINAL_PANEL_KINDS as readonly string[]).includes(p.kind as string)) {
        errors.push(
          `columns[${colIndex}].panels[${panelIndex}].kind: unknown kind ${String(p.kind)}`,
        );
      }
      if (typeof p.size !== 'number' || !Number.isFinite(p.size) || p.size < MIN_TRACK_SIZE_FR) {
        errors.push(
          `columns[${colIndex}].panels[${panelIndex}].size must be a number >= ${MIN_TRACK_SIZE_FR}`,
        );
      }
    });
  });

  return errors;
}

export function isValidLayoutDefinition(def: unknown): def is LayoutDefinition {
  return validateLayoutDefinition(def).length === 0;
}

/** The out-of-the-box view (CLAUDE.md §5: "Default = screener + chart +
 * news"). P1.7b (2026-07-17) briefly added a third column for the
 * consolidated best-price board, but real usage (2026-07-18) found the
 * persistent side panel awkward next to the Screener, which already covers
 * per-exchange discovery — removed back to the original 2-column default.
 * 'bestprice' stays in TERMINAL_PANEL_KINDS and BestPricePanel is unchanged;
 * it's still reachable via the command bar's `BEST` function and, as of
 * today, via clicking a symbol in the Screener (see docs/best-price.md).
 * There is still no "add panel to an existing saved layout" UI (P1.3/P1.3c
 * only ever built resize/reorder/move-between-existing-columns), so those
 * two entry points are deliberately kept as the only ways to reach it.
 * Existing saved layouts (the `layouts` table) are untouched; only fresh
 * tabs pick this up. */
export function defaultLayoutDefinition(): LayoutDefinition {
  return {
    version: 1,
    columns: [
      { size: 1, panels: [{ kind: 'screener', size: 1 }] },
      {
        size: 1,
        panels: [
          { kind: 'chart', size: 1 },
          { kind: 'news', size: 1 },
        ],
      },
    ],
  };
}

/**
 * Browser-style workspace tabs (P1.3a, `layouts` table migration 0004):
 * generalizes P1.3's single saved layout to N named, orderable, closable
 * tabs — each row in `layouts` is now one tab, carrying its own
 * `LayoutDefinition`. Shared between the gateway (services/api-gateway/src/
 * layouts.ts) and the frontend (apps/web) so "what a tab looks like on the
 * wire" has one definition.
 */
export interface TerminalTabSummary {
  id: string;
  /** User-facing, renameable label — distinct from the DB's internal `name`. */
  title: string;
  /** Position in the tab strip, 0-indexed. */
  order: number;
  isActive: boolean;
  definition: LayoutDefinition;
}

export const MAX_TAB_TITLE_LENGTH = 40;
/** Budget guard against unbounded tab creation, same reasoning as MAX_LAYOUT_COLUMNS. */
export const MAX_TABS_PER_USER = 12;

export function isValidTabTitle(title: unknown): title is string {
  return (
    typeof title === 'string' && title.trim().length > 0 && title.length <= MAX_TAB_TITLE_LENGTH
  );
}
