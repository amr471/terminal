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
 * turns pointer/keyboard events into calls to them.
 */
import {
  Fragment,
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { LayoutDefinition, TerminalPanelKind } from '@terminal/types';
import { pixelDeltaToFr, resizeTracks } from '../resize.js';
import { Panel } from './Panel.js';

const KEYBOARD_STEP_FR = 0.1;

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
  appendColumnHandle: ReactNode;
}) {
  const columnRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <div ref={columnRef} className="t-columns__column" style={{ flex: `${column.size} ${column.size} 0%` }}>
        {column.panels.map((panel, panelIndex) => (
          <Fragment key={panelIndex}>
            <div className="t-columns__panel" style={{ flex: `${panel.size} ${panel.size} 0%` }}>
              <Panel title={panelTitle(panel.kind)}>{panelBody(panel.kind)}</Panel>
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
        ))}
      </div>
      {appendColumnHandle}
    </>
  );
}
