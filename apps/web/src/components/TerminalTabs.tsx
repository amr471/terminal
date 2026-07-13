'use client';

/**
 * Owns the terminal's tab strip (P1.3a): which tabs exist, which is active,
 * and the create/rename/reorder/close/activate mutations against
 * /api/layouts/tabs* (same-origin proxy, same cookie round-trip as
 * TerminalWorkspace's own autosave). Every mutation here is optimistic and
 * best-effort against the network, same stance as TerminalWorkspace's
 * autosave: a dropped request just means the next page load falls back to
 * whatever the server last saved, which isn't worth surfacing to the user
 * for a tab-strip tweak.
 *
 * The per-tab panel-grid state itself still lives in TerminalWorkspace,
 * remounted via `key={activeTab.id}` on every switch so its
 * `initialDefinition` (deliberately not re-applied on every render — see
 * that component's own comment) picks up the newly active tab's saved
 * layout instead of carrying over the previous tab's live drag state.
 */
import { useCallback, useState } from 'react';
import type { Locale, TerminalTabSummary } from '@terminal/types';
import { TabBar } from '@terminal/ui';
import { t } from '@terminal/i18n';
import { TerminalWorkspace } from './TerminalWorkspace';
import { swapAdjacent, reorderTo, dropTargetIndex } from '../lib/tabOrder';

export interface TerminalTabsProps {
  locale: Locale;
  initialTabs: TerminalTabSummary[];
}

function activeIdOf(tabs: TerminalTabSummary[]): string {
  return tabs.find((tab) => tab.isActive)?.id ?? tabs[0]?.id ?? '';
}

export function TerminalTabs({ locale, initialTabs }: TerminalTabsProps) {
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTabId, setActiveTabId] = useState(() => activeIdOf(initialTabs));

  const handleActivate = useCallback((id: string) => {
    setActiveTabId(id);
    fetch(`/api/layouts/tabs/${id}/activate`, { method: 'PUT' }).catch(() => {
      // Best-effort — see file header.
    });
  }, []);

  const handleClose = useCallback((id: string) => {
    setTabs((current) => {
      if (current.length <= 1) return current; // TabBar already hides close below 1 tab; belt-and-suspenders
      const closing = current.find((tab) => tab.id === id);
      const remaining = current.filter((tab) => tab.id !== id);
      if (closing?.isActive) {
        const next = remaining[0];
        if (next) setActiveTabId(next.id);
        return remaining.map((tab) => ({ ...tab, isActive: tab.id === next?.id }));
      }
      return remaining;
    });
    fetch(`/api/layouts/tabs/${id}`, { method: 'DELETE' }).catch(() => {
      // Best-effort — see file header.
    });
  }, []);

  const handleRename = useCallback((id: string, title: string) => {
    setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, title } : tab)));
    fetch(`/api/layouts/tabs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).catch(() => {
      // Best-effort — see file header.
    });
  }, []);

  const handleReorder = useCallback((id: string, direction: 'left' | 'right') => {
    setTabs((current) => {
      const next = swapAdjacent(current, id, direction);
      if (next === current) return current;
      fetch('/api/layouts/tabs/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: next.map((tab) => tab.id) }),
      }).catch(() => {
        // Best-effort — see file header.
      });
      return next;
    });
  }, []);

  const handleDropReorder = useCallback(
    (dragId: string, hoverId: string, insertAfter: boolean) => {
      setTabs((current) => {
        const targetIndex = dropTargetIndex(current, dragId, hoverId, insertAfter);
        if (targetIndex === null) return current;
        const next = reorderTo(current, dragId, targetIndex);
        const changed = next.some((tab, i) => tab.id !== current[i]?.id);
        if (!changed) return current;
        fetch('/api/layouts/tabs/reorder', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order: next.map((tab) => tab.id) }),
        }).catch(() => {
          // Best-effort — see file header.
        });
        return next;
      });
    },
    [],
  );

  const handleNewTab = useCallback(() => {
    const title = t(locale, 'terminal.tab.new');
    fetch('/api/layouts/tabs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
      .then((res) => (res.ok ? (res.json() as Promise<{ tab: TerminalTabSummary }>) : null))
      .then((body) => {
        if (!body?.tab) return;
        const created = body.tab;
        setTabs((current) => [...current.map((tab) => ({ ...tab, isActive: false })), created]);
        setActiveTabId(created.id);
      })
      .catch(() => {
        // New-tab creation failing silently is acceptable here too — the
        // user just sees nothing happen and can retry (same stance as the
        // rest of this file; unlike autosave there's no local state to
        // roll back since nothing was added optimistically).
      });
  }, [locale]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <>
      <TabBar
        tabs={tabs.map((tab) => ({ id: tab.id, title: tab.title }))}
        activeTabId={activeTabId}
        onActivate={handleActivate}
        onClose={handleClose}
        onRename={handleRename}
        onReorder={handleReorder}
        onDropReorder={handleDropReorder}
        onNewTab={handleNewTab}
        tablistLabel={t(locale, 'terminal.tab.list_label')}
        newTabLabel={t(locale, 'terminal.tab.new')}
        closeTabLabel={t(locale, 'terminal.tab.close')}
      />
      {activeTab && (
        <TerminalWorkspace
          key={activeTab.id}
          locale={locale}
          tabId={activeTab.id}
          initialDefinition={activeTab.definition}
        />
      )}
    </>
  );
}
