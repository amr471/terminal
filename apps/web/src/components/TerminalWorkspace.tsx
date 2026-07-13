'use client';

/**
 * Client wrapper around @terminal/ui's ResizableColumns: owns the
 * debounced autosave to PUT /api/layouts/tabs/:tabId (relative URL —
 * proxied same-origin by next.config.mjs, exactly like SignupForm's POST,
 * so the session cookie round-trips the same way) and supplies the
 * placeholder panel content/titles (real Screener/Chart/News panels land
 * at P1.6–P1.10; this proves the shell mechanics ahead of the data).
 *
 * `tabId` (P1.3a) picks which tab this save targets — the caller
 * (TerminalTabs.tsx) remounts this component with `key={tabId}` on every
 * tab switch, since `initialDefinition` is only read once on mount.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Locale, LayoutDefinition, TerminalPanelKind } from '@terminal/types';
import { ResizableColumns } from '@terminal/ui';
import { t, type MessageKey } from '@terminal/i18n';

const PANEL_TITLE_KEY: Record<TerminalPanelKind, MessageKey> = {
  screener: 'nav.screener',
  chart: 'nav.charts',
  news: 'nav.news',
};

const PANEL_BODY_KEY: Record<TerminalPanelKind, MessageKey> = {
  screener: 'terminal.panel.screener_body',
  chart: 'terminal.panel.chart_body',
  news: 'terminal.panel.news_body',
};

const SAVE_DEBOUNCE_MS = 600;

export interface TerminalWorkspaceProps {
  locale: Locale;
  tabId: string;
  initialDefinition: LayoutDefinition;
}

export function TerminalWorkspace({ locale, tabId, initialDefinition }: TerminalWorkspaceProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const handleChange = useCallback(
    (next: LayoutDefinition) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        fetch(`/api/layouts/tabs/${tabId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: next }),
        }).catch(() => {
          // Best-effort autosave — a dropped save just means the next
          // resize (or next page load, which falls back to the
          // last-saved layout) retries. Not worth surfacing to the user
          // for a workspace tweak.
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [tabId],
  );

  return (
    <ResizableColumns
      initialDefinition={initialDefinition}
      onChange={handleChange}
      panelTitle={(kind) => t(locale, PANEL_TITLE_KEY[kind])}
      panelBody={(kind) => t(locale, PANEL_BODY_KEY[kind])}
      resizeHandleLabel={t(locale, 'terminal.resize_handle')}
    />
  );
}
