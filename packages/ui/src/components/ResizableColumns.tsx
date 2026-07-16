'use client';

/**
 * Resizable terminal workspace (P1.3 — see WorkspaceGrid.tsx's original
 * "drag/resize/save-layout logic lands at P1.3" comment). Built as flexbox
 * rather than extending WorkspaceGrid's CSS-grid-areas model: a fully
 * general resizable N×M grid needs synchronized gutter tracks in both
 * dimensions, which is a lot of machinery for the same visual result that
 * two nested flex axes give for free (columns side by side, each column an
 * independent vertical stack — the model @terminal/types' LayoutDefinition
 * already encodes). WorkspaceGrid stays for simpler static layouts
 * elsewhere; this is the interactive one the terminal shell uses.
 *
 * All resize math is the pure functions in resize.ts — this component only
 * turns pointer/keyboard events into calls to them. Panel repositioning
 * (P1.3c) follows the same split: `movePanel` (panelOrder.ts) does the
 * array surgery, this component only turns drag/keyboard events into calls
 * to it — same pattern @terminal/ui's TabBar/apps/web's tabOrder.ts already
 * established for tab reordering (P1.3b), except here the component owns
 * the array itself (like resize) rather than reporting up to a caller
 * (like TabBar does), since ResizableColumns already owns `definition`.
 */
import {
  Fragment,
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { LayoutDefinition, TerminalPanelKind } from '@terminal/types';
import { pixelDeltaToFr, resizeTracks } from '../resize.js';
import { movePanel, type PanelCoords } from '../panelOrder.js';
import { Panel } from './Panel.js';

const KEYBOARD_STEP_FR = 0.1;

interface PanelDropIndicator extends PanelCoords {
  side: 'before' | 'after';
}

function samePanel(a: PanelCoords, b: PanelCoords): boolean {
  return a.col === b.col && a.panel === b.panel;
}

export interface ResizableColumnsProps {
  /** Used to seed local state on mount; not re-applied on every parent render
   * (this component owns live drag state so resizing stays smooth). */
  initialDefinition: LayoutDefinition;
  /** Fired after every resize step — the caller decides whether/how to persist it (debounce, etc). */
  onChange?: (next: LayoutDefinition) => void;
  panelTitle: (kind: TerminalPanelKind) => string;
  panelBody: (kind: TerminalPanelKind) => ReactNode;
  /** Localized aria-label for every drag handle, e.g. t(locale, 'terminal.resize_handle'). */
  resizeHandleLabel: string;
}

export function ResizableColumns({
  initialDefinition,
  onChange,
  panelTitle,
  panelBody,
  resizeHandleLabel,
}: ResizableColumnsProps) {
  const [definition, setDefinition] = useState(initialDefinition);
  const containerRef = useRef<HTMLDivElement>(null);

  const resizeColumn = useCallback(
    (index: number, deltaFr: number) => {
      setDefinition((current) => {
        const sizes = resizeTracks(
          current.columns.map((c) => c.size),
          index,
          deltaFr,
        );
        const next: LayoutDefinition = {
          ...current,
          columns: current.columns.map((c, i) => ({ ...c, size: sizes[i]! })),
        };
        onChange?.(next);
        return next;
      });
    },
    [onChange],
  );

  const resizeRow = useCallback(
    (colIndex: number, index: number, deltaFr: number) => {
      setDefinition((current) => {
        const column = current.columns[colIndex];
        if (!column) return current;
        const sizes = resizeTracks(
          column.panels.map((p) => p.size),
          index,
          deltaFr,
        );
        const next: LayoutDefinition = {
          ...current,
          columns: current.columns.map((c, i) =>
            i === colIndex ? { ...c, panels: c.panels.map((p, j) => ({ ...p, size: sizes[j]! })) } : c,
          ),
        };
        onChange?.(next);
        return next;
      });
    },
    [onChange],
  );

  const [dragFrom, setDragFrom] = useState<PanelCoords | null>(null);
  const [dropIndicator, setDropIndicator] = useState<PanelDropIndicator | null>(null);

  const movePanelTo = useCallback(
    (from: PanelCoords, hover: PanelCoords, insertAfter: boolean) => {
      setDefinition((current) => {
        const next = movePanel(current, from, hover, insertAfter);
        if (next === current) return current;
        onChange?.(next);
        return next;
      });
    },
    [onChange],
  );

  function clearPanelDragState(): void {
    setDragFrom(null);
    setDropIndicator(null);
  }

  const onPanelHeaderDragStart = (coords: PanelCoords) => (event: DragEvent<HTMLElement>) => {
    setDragFrom(coords);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${coords.col}:${coords.panel}`);
  };

  const onPanelDragOver = (coords: PanelCoords) => (event: DragEvent<HTMLDivElement>) => {
    if (!dragFrom || samePanel(dragFrom, coords)) return;
    event.preventDefault(); // required for onDrop to fire at all
    const rect = event.currentTarget.getBoundingClientRect();
    const side: PanelDropIndicator['side'] =
      event.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
    setDropIndicator((current) =>
      current && samePanel(current, coords) && current.side === side
        ? current
        : { ...coords, side },
    );
  };

  const onPanelDrop = (coords: PanelCoords) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (dragFrom && !samePanel(dragFrom, coords) && dropIndicator && samePanel(dropIndicator, coords)) {
      movePanelTo(dragFrom, coords, dropIndicator.side === 'after');
    }
    clearPanelDragState();
  };

  /** Alt+ArrowUp/Down move the panel within its column (swap with the
   * adjacent panel); Alt+ArrowLeft/Right move it to the end of the
   * adjacent column. Mouse drag above is the discoverable path; this is
   * the a11y fallback, same convention TabBar's Alt+ArrowLeft/Right and
   * the resize handles' plain arrow keys already established. */
  const onPanelHeaderKeyDown = (coords: PanelCoords) => (event: KeyboardEvent) => {
    if (!event.altKey) return;
    const column = definition.columns[coords.col];
    if (!column) return;

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const hoverPanel = coords.panel + (event.key === 'ArrowUp' ? -1 : 1);
      if (hoverPanel < 0 || hoverPanel >= column.panels.length) return;
      movePanelTo(coords, { col: coords.col, panel: hoverPanel }, event.key === 'ArrowDown');
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const hoverCol = coords.col + (event.key === 'ArrowLeft' ? -1 : 1);
      const targetColumn = definition.columns[hoverCol];
      if (!targetColumn) return;
      movePanelTo(coords, { col: hoverCol, panel: targetColumn.panels.length - 1 }, true);
    }
  };

  const onColumnHandlePointerDown = (index: number) => (event: PointerEvent) => {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const startX = event.clientX;
    const totalFr = definition.columns.reduce((sum, c) => sum + c.size, 0);

    function onMove(moveEvent: globalThis.PointerEvent): void {
      const deltaFr = pixelDeltaToFr(moveEvent.clientX - startX, containerWidth, totalFr);
      resizeColumn(index, deltaFr);
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onColumnHandleKeyDown = (index: number) => (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      resizeColumn(index, -KEYBOARD_STEP_FR);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      resizeColumn(index, KEYBOARD_STEP_FR);
    }
  };

  const onRowHandlePointerDown = (colIndex: number, index: number, columnEl: HTMLDivElement | null) => (
    event: PointerEvent,
  ) => {
    event.preventDefault();
    if (!columnEl) return;
    const columnHeight = columnEl.getBoundingClientRect().height;
    const startY = event.clientY;
    const column = definition.columns[colIndex];
    const totalFr = column ? column.panels.reduce((sum, p) => sum + p.size, 0) : 1;

    function onMove(moveEvent: globalThis.PointerEvent): void {
      const deltaFr = pixelDeltaToFr(moveEvent.clientY - startY, columnHeight, totalFr);
      resizeRow(colIndex, index, deltaFr);
    }
    function onUp(): void {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onRowHandleKeyDown = (colIndex: number, index: number) => (event: KeyboardEvent) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      resizeRow(colIndex, index, -KEYBOARD_STEP_FR);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      resizeRow(colIndex, index, KEYBOARD_STEP_FR);
    }
  };

  return (
    <div ref={containerRef} className="t-columns">
      {definition.columns.map((column, colIndex) => (
        <ColumnWithRowHandles
          key={colIndex}
          colIndex={colIndex}
          column={column}
          panelTitle={panelTitle}
          panelBody={panelBody}
          resizeHandleLabel={resizeHandleLabel}
          onRowHandlePointerDown={onRowHandlePointerDown}
          onRowHandleKeyDown={onRowHandleKeyDown}
          dragFrom={dragFrom}
          dropIndicator={dropIndicator}
          onPanelHeaderDragStart={onPanelHeaderDragStart}
          onPanelDragOver={onPanelDragOver}
          onPanelDrop={onPanelDrop}
          onPanelDragEnd={clearPanelDragState}
          onPanelHeaderKeyDown={onPanelHeaderKeyDown}
          appendColumnHandle={
            colIndex < definition.columns.length - 1 ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={resizeHandleLabel}
                tabIndex={0}
                className="t-resize-handle t-resize-handle--col"
                onPointerDown={onColumnHandlePointerDown(colIndex)}
                onKeyDown={onColumnHandleKeyDown(colIndex)}
              />
            ) : null
          }
        />
      ))}
    </div>
  );
}

function ColumnWithRowHandles({
  column,
  colIndex,
  panelTitle,
  panelBody,
  resizeHandleLabel,
  onRowHandlePointerDown,
  onRowHandleKeyDown,
  dragFrom,
  dropIndicator,
  onPanelHeaderDragStart,
  onPanelDragOver,
  onPanelDrop,
  onPanelDragEnd,
  onPanelHeaderKeyDown,
  appendColumnHandle,
}: {
  column: LayoutDefinition['columns'][number];
  colIndex: number;
  panelTitle: (kind: TerminalPanelKind) => string;
  panelBody: (kind: TerminalPanelKind) => ReactNode;
  resizeHandleLabel: string;
  onRowHandlePointerDown: (
    colIndex: number,
    index: number,
    columnEl: HTMLDivElement | null,
  ) => (event: PointerEvent) => void;
  onRowHandleKeyDown: (colIndex: number, index: number) => (event: KeyboardEvent) => void;
  dragFrom: PanelCoords | null;
  dropIndicator: PanelDropIndicator | null;
  onPanelHeaderDragStart: (coords: PanelCoords) => (event: DragEvent<HTMLElement>) => void;
  onPanelDragOver: (coords: PanelCoords) => (event: DragEvent<HTMLDivElement>) => void;
  onPanelDrop: (coords: PanelCoords) => (event: DragEvent<HTMLDivElement>) => void;
  onPanelDragEnd: () => void;
  onPanelHeaderKeyDown: (coords: PanelCoords) => (event: KeyboardEvent) => void;
  appendColumnHandle: ReactNode;
}) {
  const columnRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div ref={columnRef} className="t-columns__column" style={{ flex: `${column.size} ${column.size} 0%` }}>
        {column.panels.map((panel, panelIndex) => {
          const coords: PanelCoords = { col: colIndex, panel: panelIndex };
          const dragging = !!dragFrom && samePanel(dragFrom, coords);
          const indicator =
            dropIndicator && samePanel(dropIndicator, coords) ? dropIndicator.side : null;
          const panelClassName = [
            't-columns__panel',
            dragging && 't-columns__panel--dragging',
            indicator && `t-columns__panel--drop-${indicator}`,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <Fragment key={panelIndex}>
              <div
                className={panelClassName}
                style={{ flex: `${panel.size} ${panel.size} 0%` }}
                data-panel-kind={panel.kind}
                onDragOver={onPanelDragOver(coords)}
                onDrop={onPanelDrop(coords)}
              >
                <Panel
                  title={panelTitle(panel.kind)}
                  headerProps={{
                    draggable: true,
                    tabIndex: 0,
                    'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight',
                    onDragStart: onPanelHeaderDragStart(coords),
                    onDragEnd: onPanelDragEnd,
                    onKeyDown: onPanelHeaderKeyDown(coords),
                  }}
                >
                  {panelBody(panel.kind)}
                </Panel>
              </div>
              {panelIndex < column.panels.length - 1 && (
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label={resizeHandleLabel}
                  tabIndex={0}
                  className="t-resize-handle t-resize-handle--row"
                  onPointerDown={onRowHandlePointerDown(colIndex, panelIndex, columnRef.current)}
                  onKeyDown={onRowHandleKeyDown(colIndex, panelIndex)}
                />
              )}
            </Fragment>
          );
        })}
      </div>
      {appendColumnHandle}
    </>
  );
}
