/**
 * Panel — the dockable-workspace building block. Minimal chrome: a slim
 * title row and a data body; every pixel of chrome must earn its place
 * (CLAUDE.md §5).
 */
import type { HTMLAttributes, ReactNode } from 'react';

export interface PanelProps {
  title: string;
  /** Right-aligned header widgets (health badge, actions). */
  headerRight?: ReactNode;
  focused?: boolean;
  children: ReactNode;
  /**
   * Spread onto the `<header>` — lets a caller (ResizableColumns, P1.3c)
   * turn the header into a drag handle for repositioning the panel,
   * without making the whole panel (including its data body, where future
   * real content will want text selection / row interaction) draggable.
   * Panel itself stays presentational and unaware of drag-and-drop.
   */
  headerProps?: HTMLAttributes<HTMLElement>;
}

export function Panel({ title, headerRight, focused = false, children, headerProps }: PanelProps) {
  return (
    <section className={`t-panel${focused ? ' t-panel--focused' : ''}`}>
      <header className="t-panel__header" {...headerProps}>
        <h2 className="t-panel__title">{title}</h2>
        {headerRight !== undefined && <div className="t-panel__actions">{headerRight}</div>}
      </header>
      <div className="t-panel__body">{children}</div>
    </section>
  );
}
