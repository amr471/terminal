/**
 * Workspace grid primitives — CSS-grid shell for simple static multi-panel
 * layouts. The terminal shell's interactive, resizable/saveable workspace
 * (P1.3) turned out cleaner as flexbox (ResizableColumns.tsx) — a general
 * resizable CSS-grid needs synchronized gutter tracks in both dimensions,
 * more machinery than two nested flex axes for the same result. This stays
 * available for any future layout that's genuinely static.
 */
import type { ReactNode } from 'react';

export interface WorkspaceGridProps {
  /** CSS grid-template-areas string, e.g. '"screener chart" "screener news"'. */
  areas: string;
  columns?: string;
  rows?: string;
  children: ReactNode;
}

export function WorkspaceGrid({
  areas,
  columns = '1fr 1fr',
  rows = '1fr 1fr',
  children,
}: WorkspaceGridProps) {
  return (
    <div
      className="t-workspace"
      style={{ gridTemplateAreas: areas, gridTemplateColumns: columns, gridTemplateRows: rows }}
    >
      {children}
    </div>
  );
}

export interface GridAreaProps {
  area: string;
  children: ReactNode;
}

export function GridArea({ area, children }: GridAreaProps) {
  return (
    <div className="t-workspace__area" style={{ gridArea: area }}>
      {children}
    </div>
  );
}
