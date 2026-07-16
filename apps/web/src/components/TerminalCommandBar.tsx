'use client';

/**
 * Thin client wrapper around @terminal/ui's CommandBar. Needed because the
 * terminal page itself is a Server Component and can't pass a function
 * (onCommand) across the server/client boundary — this owns that handler
 * (and now the P1.5 destination logic) locally instead.
 *
 * Destination scope, deliberately honest about what's actually built yet:
 * CHART/NEWS/SCREEN map to the three real panel kinds ResizableColumns can
 * render (@terminal/types' TerminalPanelKind) — a matching command scrolls
 * to and briefly highlights that panel *if the active tab's layout has
 * one*, via a plain DOM query against the `data-panel-kind` attribute
 * ResizableColumns sets on each panel wrapper. That's a deliberate,
 * decoupled choice over threading React state across from TerminalTabs:
 * CommandBar and TerminalTabs are unrelated siblings under the server
 * page.tsx, and "find the element and scroll to it" doesn't need to be
 * reactive the way, say, autosave state does.
 *
 * HEAT/CAL/JRNL/AL have no built feature to jump to at all yet, and symbol
 * commands (BTC, AAPL, ...) have nowhere real to go either (no
 * per-instrument view exists before P1.6+). Both surface a plain
 * "not built yet" message instead of the previous silent no-op — worth
 * saying now that P1.5's fuzzy palette makes commands feel more like real
 * input than the bare parse-only skeleton did.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CommandBar, type ParsedCommand, type CommandFunction } from '@terminal/ui';
import type { Locale, TerminalPanelKind } from '@terminal/types';
import { t } from '@terminal/i18n';
import { PLACEHOLDER_COMMAND_SYMBOLS } from '../lib/placeholderSymbols';

const FN_PANEL_KIND: Partial<Record<CommandFunction, TerminalPanelKind>> = {
  CHART: 'chart',
  NEWS: 'news',
  SCREEN: 'screener',
};

const HIGHLIGHT_MS = 1500;
const MESSAGE_MS = 3000;

export interface TerminalCommandBarProps {
  locale: Locale;
  placeholder: string;
}

export function TerminalCommandBar({ locale, placeholder }: TerminalCommandBarProps) {
  const [message, setMessage] = useState<string | null>(null);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (messageTimer.current) clearTimeout(messageTimer.current);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    },
    [],
  );

  const showNotAvailable = useCallback(() => {
    setMessage(t(locale, 'terminal.command_not_available'));
    if (messageTimer.current) clearTimeout(messageTimer.current);
    messageTimer.current = setTimeout(() => setMessage(null), MESSAGE_MS);
  }, [locale]);

  const handleCommand = useCallback(
    (command: ParsedCommand) => {
      const kind = command.symbol ? undefined : FN_PANEL_KIND[command.fn];
      if (!kind) {
        showNotAvailable();
        return;
      }
      const el = document.querySelector<HTMLElement>(`[data-panel-kind="${kind}"]`);
      if (!el) {
        showNotAvailable();
        return;
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('t-columns__panel--jump-highlight');
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => {
        el.classList.remove('t-columns__panel--jump-highlight');
      }, HIGHLIGHT_MS);
    },
    [showNotAvailable],
  );

  return (
    <div className="terminal-shell__command-wrap">
      <CommandBar
        locale={locale}
        placeholder={placeholder}
        symbols={PLACEHOLDER_COMMAND_SYMBOLS}
        onCommand={handleCommand}
      />
      {message && (
        <p className="terminal-shell__command-message" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
