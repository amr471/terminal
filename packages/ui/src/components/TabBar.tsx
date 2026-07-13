'use client';

/**
 * Browser-style workspace tab strip (P1.3a). WAI-ARIA "manual activation"
 * tabs pattern: role="tablist"/"tab", roving tabIndex, plain ArrowLeft/Right
 * move focus between tabs (Enter/Space activates the focused one) — that's
 * the standard keyboard model, so it's left alone. Reordering is layered on
 * top via Alt+ArrowLeft/Right (advertised through aria-keyshortcuts) rather
 * than overloading the plain arrow keys, which the tablist pattern already
 * claims for focus movement. Renaming is double-click-to-edit, inline.
 *
 * All mutation is via callbacks — this component holds only its own local
 * "currently editing which tab" state; the caller (apps/web's
 * TerminalTabs.tsx) owns the tab list itself and talks to the gateway.
 */
import { useRef, useState, type KeyboardEvent } from 'react';

export interface TabBarTab {
  id: string;
  title: string;
}

export interface TabBarProps {
  tabs: TabBarTab[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onReorder: (id: string, direction: 'left' | 'right') => void;
  onNewTab: () => void;
  /** aria-label for the tablist itself, e.g. t(locale, 'terminal.tab.list_label'). */
  tablistLabel: string;
  /** aria-label for the "+" button, e.g. t(locale, 'terminal.tab.new'). */
  newTabLabel: string;
  /** Prefix for each close button's aria-label, e.g. t(locale, 'terminal.tab.close'). */
  closeTabLabel: string;
}

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onRename,
  onReorder,
  onNewTab,
  tablistLabel,
  newTabLabel,
  closeTabLabel,
}: TabBarProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  function focusTab(id: string): void {
    listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus();
  }

  function commitRename(id: string): void {
    const trimmed = draft.trim();
    if (trimmed) onRename(id, trimmed);
    setEditingId(null);
  }

  const onTabKeyDown = (id: string, index: number) => (event: KeyboardEvent) => {
    if (editingId === id) return; // the <input> handles its own keys
    if (event.key === 'ArrowLeft' && event.altKey) {
      event.preventDefault();
      onReorder(id, 'left');
    } else if (event.key === 'ArrowRight' && event.altKey) {
      event.preventDefault();
      onReorder(id, 'right');
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const prev = tabs[index - 1];
      if (prev) focusTab(prev.id);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const next = tabs[index + 1];
      if (next) focusTab(next.id);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate(id);
    }
  };

  return (
    <div className="t-tabbar">
      <div ref={listRef} role="tablist" aria-label={tablistLabel} className="t-tabbar__list">
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          const editing = editingId === tab.id;
          return (
            <div
              key={tab.id}
              role="tab"
              data-tab-id={tab.id}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={`t-tabbar__tab${active ? ' t-tabbar__tab--active' : ''}`}
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
              onClick={() => !editing && onActivate(tab.id)}
              onDoubleClick={() => {
                setDraft(tab.title);
                setEditingId(tab.id);
              }}
              onKeyDown={onTabKeyDown(tab.id, index)}
            >
              {editing ? (
                <input
                  className="t-tabbar__input"
                  value={draft}
                  autoFocus
                  onChange={(event) => setDraft(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={() => commitRename(tab.id)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitRename(tab.id);
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditingId(null);
                    }
                  }}
                />
              ) : (
                <span className="t-tabbar__title">{tab.title}</span>
              )}
              {!editing && tabs.length > 1 && (
                <button
                  type="button"
                  className="t-tabbar__close"
                  aria-label={`${closeTabLabel}: ${tab.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(tab.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button type="button" className="t-tabbar__new" aria-label={newTabLabel} onClick={onNewTab}>
        +
      </button>
    </div>
  );
}
