/**
 * Panel — the dockable-workspace building block. Minimal chrome: a slim
 * title row and a data body; every pixel of chrome must earn its place
 * (CLAUDE.md §5).
 */
import type { ReactNode } from 'react';

export interface PanelProps {
  title: string;
  /** Right-aligned header widgets (health badge, actions). */
  headerRight?: ReactNode;
  focused?: boolean;
  children: ReactNode;
}

export function Panel({ title, headerRight, focused = false, children }: PanelProps) {
  return (
    <section className={`t-panel${focused ? ' t-panel--focused' : ''}`}>
      <header className="t-panel__header">
        <h2 className="t-panel__title">{title}</h2>
        {headerRight !== undefined && <div className="t-panel__actions">{headerRight}</div>}
      </header>
      <div className="t-panel__body">{children}</div>
    </section>
  );
}
