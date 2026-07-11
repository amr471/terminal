/**
 * Workspace grid primitives — CSS-grid shell for the dockable multi-panel
 * workspace. Static template now; drag/resize/save-layout logic lands at
 * P1.3 (layouts persist via `layouts.definition`).
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
