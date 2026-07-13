/**
 * Pure panel-reposition math for the terminal shell's workspace grid
 * (P1.3c) — moving a panel into a different column/position, layered on
 * top of P1.3's existing columns-of-stacked-panels `LayoutDefinition`
 * (packages/types/src/layout.ts) rather than a new data model. Kept free
 * of any DOM/drag-event code, same reasoning resize.ts already follows:
 * directly node:test-testable, no jsdom needed.
 *
 * Deliberately scoped to moving a panel into an *existing* column/position
 * — not dragging into empty space to create a brand-new column. That
 * keeps this from growing into rebuilding the layout-creation UI; a
 * future task if wanted.
 */
import { MAX_PANELS_PER_COLUMN, type LayoutColumn, type LayoutDefinition } from '@terminal/types';

export interface PanelCoords {
  col: number;
  panel: number;
}

function cloneDefinition(definition: LayoutDefinition): LayoutDefinition {
  return {
    ...definition,
    columns: definition.columns.map((c) => ({ ...c, panels: c.panels.map((p) => ({ ...p })) })),
  };
}

/**
 * Moves the panel at `from` to land at `hover` (before or after it,
 * per `insertAfter`) — both are indices into the current, pre-move
 * `definition`, the same snapshot a drag gesture or a keyboard step
 * observes throughout (nothing else mutates state mid-gesture).
 *
 * Two things panels need that P1.3b's tab reorder didn't:
 *  - moving the *last* panel out of a column removes that column
 *    entirely, rather than leaving an empty, schema-invalid column
 *    behind — the remaining columns' space redistributes for free via
 *    flex, no extra size math needed;
 *  - a move that would push the destination column over
 *    `MAX_PANELS_PER_COLUMN` is rejected outright (no-op), same
 *    reject-rather-than-partial-clamp stance `resizeTracks` already
 *    takes on the floor.
 */
export function movePanel(
  definition: LayoutDefinition,
  from: PanelCoords,
  hover: PanelCoords,
  insertAfter: boolean,
): LayoutDefinition {
  const fromColumn = definition.columns[from.col];
  const hoverColumn = definition.columns[hover.col];
  if (!fromColumn || !hoverColumn) return cloneDefinition(definition);

  const moving = fromColumn.panels[from.panel];
  if (!moving) return cloneDefinition(definition);
  if (hover.panel < 0 || hover.panel >= hoverColumn.panels.length) {
    return cloneDefinition(definition);
  }
  if (from.col === hover.col && from.panel === hover.panel) return cloneDefinition(definition);

  const sourceWillEmpty = fromColumn.panels.length === 1;

  // Remove the source panel (and its column, if that empties it out),
  // tracking how much that shifts hover.col in the resulting array.
  const workingColumns: LayoutColumn[] = [];
  let adjustedHoverCol = hover.col;
  definition.columns.forEach((column, colIndex) => {
    if (colIndex === from.col) {
      const remainingPanels = column.panels.filter((_, i) => i !== from.panel);
      if (remainingPanels.length === 0) {
        if (hover.col > from.col) adjustedHoverCol -= 1;
        return; // column dropped entirely
      }
      workingColumns.push({ ...column, panels: remainingPanels });
      return;
    }
    workingColumns.push({ ...column, panels: [...column.panels] });
  });

  const targetColumn = workingColumns[adjustedHoverCol];
  if (!targetColumn) return cloneDefinition(definition);

  const crossColumn = from.col !== hover.col;
  if (crossColumn && targetColumn.panels.length >= MAX_PANELS_PER_COLUMN) {
    return cloneDefinition(definition);
  }

  let targetPanelIndex = insertAfter ? hover.panel + 1 : hover.panel;
  if (!crossColumn && !sourceWillEmpty && from.panel < targetPanelIndex) {
    targetPanelIndex -= 1;
  }
  targetPanelIndex = Math.max(0, Math.min(targetPanelIndex, targetColumn.panels.length));
  targetColumn.panels.splice(targetPanelIndex, 0, moving);

  return { ...definition, columns: workingColumns };
}
