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
 * P1.3b adds mouse drag-and-drop reordering on top of that same
 * Alt+ArrowLeft/Right path — the keyboard route stays exactly as it was
 * (the accessible fallback this task was scoped to preserve, not replace).
 * Native HTML5 drag-and-drop, no new dependency: `draggable` + `onDragStart`/
 * `onDragOver`/`onDrop`/`onDragEnd`. This component only tracks which tab is
 * being dragged and which half of the hovered tab the pointer is over
 * (before/after) — converting that into an actual array index is
 * `onDropReorder`'s caller's job (apps/web's `dropTargetIndex`/`reorderTo`
 * in tabOrder.ts, unit-tested independent of real drag events, which
 * `node --test` can't simulate), same split `onReorder`'s `swapAdjacent`
 * already uses.
 *
 * All mutation is via callbacks — this component holds only its own local
 * "currently editing which tab" and "currently dragging which tab" state;
 * the caller (apps/web's TerminalTabs.tsx) owns the tab list itself and
 * talks to the gateway.
 */
import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react';

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
  /** Mouse drag-and-drop reorder (P1.3b). This component only knows which
   * tab was dragged, which tab it was dropped on, and which half of that
   * tab (before/after) — it deliberately does NOT compute the resulting
   * array itself (that's apps/web's tabOrder.ts's `dropTargetIndex` +
   * `reorderTo`, same as `onReorder`'s `swapAdjacent` above); packages/ui
   * must not depend on apps/web. */
  onDropReorder: (dragId: string, hoverId: string, insertAfter: boolean) => void;
  onNewTab: () => void;
  /** aria-label for the tablist itself, e.g. t(locale, 'terminal.tab.list_label'). */
  tablistLabel: string;
  /** aria-label for the "+" button, e.g. t(locale, 'terminal.tab.new'). */
  newTabLabel: string;
  /** Prefix for each close button's aria-label, e.g. t(locale, 'terminal.tab.close'). */
  closeTabLabel: string;
}

interface DropIndicator {
  id: string;
  side: 'before' | 'after';
}

export function TabBar({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onRename,
  onReorder,
  onDropReorder,
  onNewTab,
  tablistLabel,
  newTabLabel,
  closeTabLabel,
}: TabBarProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  function clearDragState(): void {
    setDragId(null);
    setDropIndicator(null);
  }

  function onTabDragStart(id: string) {
    return (event: DragEvent<HTMLDivElement>) => {
      setDragId(id);
      event.dataTransfer.effectAllowed = 'move';
      // Firefox requires data actually be set for the drag to start.
      event.dataTransfer.setData('text/plain', id);
    };
  }

  function onTabDragOver(id: string) {
    return (event: DragEvent<HTMLDivElement>) => {
      if (!dragId || dragId === id) return;
      event.preventDefault(); // required for onDrop to fire at all
      const rect = event.currentTarget.getBoundingClientRect();
      const side: DropIndicator['side'] =
        event.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
      setDropIndicator((current) =>
        current?.id === id && current.side === side ? current : { id, side },
      );
    };
  }

  function onTabDrop(id: string) {
    return (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (dragId && dragId !== id && dropIndicator?.id === id) {
        onDropReorder(dragId, id, dropIndicator.side === 'after');
      }
      clearDragState();
    };
  }

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
          const dragging = dragId === tab.id;
          const indicator = dropIndicator?.id === tab.id ? dropIndicator.side : null;
          const className = [
            't-tabbar__tab',
            active && 't-tabbar__tab--active',
            dragging && 't-tabbar__tab--dragging',
            indicator && `t-tabbar__tab--drop-${indicator}`,
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={tab.id}
              role="tab"
              data-tab-id={tab.id}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={className}
              aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
              draggable={!editing}
              onClick={() => !editing && onActivate(tab.id)}
              onDoubleClick={() => {
                setDraft(tab.title);
                setEditingId(tab.id);
              }}
              onKeyDown={onTabKeyDown(tab.id, index)}
              onDragStart={onTabDragStart(tab.id)}
              onDragOver={onTabDragOver(tab.id)}
              onDragLeave={() =>
                setDropIndicator((current) => (current?.id === tab.id ? null : current))
              }
              onDrop={onTabDrop(tab.id)}
              onDragEnd={clearDragState}
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
