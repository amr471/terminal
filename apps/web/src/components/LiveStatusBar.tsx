'use client';

/**
 * Client-side ticking wrapper around @terminal/ui's StatusBar.
 *
 * StatusBar itself stays a plain, server-safe presentational component that
 * takes an explicit `now` (so its existing session/overlap tests stay
 * deterministic) — it does not tick on its own, per its own doc comment
 * ("re-render once per second upstream"). This is that upstream piece:
 * server renders the shell once with `initialNowIso` (the request-time
 * timestamp) so there's no hydration mismatch, then a 1s client interval
 * takes over from there.
 *
 * This covers the fixed NY clock (and, as a side effect, the session
 * active/overlap highlighting, since both are derived from the same `now`)
 * plus the P1.4a secondary user-timezone clock. It also drives the live-news
 * ticker and "next high-impact event" chip, both backed by
 * `../lib/placeholderFeed.ts`'s mock data — TASKS.md's own P1.4 note is
 * explicit these ship with placeholder sources first; real data replaces
 * them at P1.9 (news pipeline) and P1.11 (economic calendar), at which point
 * `placeholderFeed.ts` gets deleted and this component swaps in a real feed
 * hook rather than growing this rotation logic further. `ticker`/
 * `nextEventHours` are therefore omitted from this component's own props —
 * always computed here, never caller-supplied — unlike `StatusBar` itself,
 * which stays generic and still accepts them directly.
 *
 * Secondary-clock persistence (P1.4a): the chosen IANA zone is stored in
 * `localStorage` under `terminal.secondaryTz` — a browser-local preference,
 * not synced to the account across devices. See docs/terminal-shell.md for
 * the scope call. Read lazily in a `useEffect` (not `useState`'s
 * initializer) so the server-rendered first paint and the client's first
 * render match before localStorage is consulted — the same hydration-safety
 * shape `initialNowIso` already uses for the clock itself.
 */
import { useEffect, useMemo, useState } from 'react';
import { StatusBar, SecondaryClock, type StatusBarProps } from '@terminal/ui';
import { isValidTimezone } from '@terminal/i18n';
import {
  PLACEHOLDER_NEWS_ITEMS,
  newsHeadlineFor,
  nextPlaceholderEvent,
} from '../lib/placeholderFeed';

export interface LiveStatusBarProps extends Omit<
  StatusBarProps,
  'now' | 'secondaryClock' | 'ticker' | 'nextEventHours'
> {
  /** Request-time timestamp (ISO), used only to seed the first paint. */
  initialNowIso: string;
}

const SECONDARY_TZ_STORAGE_KEY = 'terminal.secondaryTz';
/** Rotation cadence for the placeholder news ticker — arbitrary, mock data only. */
const TICKER_ROTATE_MS = 8000;

export function LiveStatusBar({ initialNowIso, ...rest }: LiveStatusBarProps) {
  const [now, setNow] = useState(() => new Date(initialNowIso));
  const [secondaryTz, setSecondaryTz] = useState<string | null>(null);
  const [tickerIndex, setTickerIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      setTickerIndex((i) => (i + 1) % PLACEHOLDER_NEWS_ITEMS.length);
    }, TICKER_ROTATE_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(SECONDARY_TZ_STORAGE_KEY);
    if (stored && isValidTimezone(stored)) setSecondaryTz(stored);
  }, []);

  function handleSelectTz(tz: string): void {
    setSecondaryTz(tz);
    window.localStorage.setItem(SECONDARY_TZ_STORAGE_KEY, tz);
  }

  function handleClearTz(): void {
    setSecondaryTz(null);
    window.localStorage.removeItem(SECONDARY_TZ_STORAGE_KEY);
  }

  // Recomputed only when the minute actually changes (not every 1s tick) —
  // both are coarse-grained (whole hours / an 8s-rotating headline), so
  // recalculating on every second's `now` would be pure waste.
  const minuteBucket = Math.floor(now.getTime() / 60000);
  const nextEventHours = useMemo(
    () => nextPlaceholderEvent(new Date(minuteBucket * 60000)).hoursUntil,
    [minuteBucket],
  );
  const ticker = newsHeadlineFor(rest.locale, PLACEHOLDER_NEWS_ITEMS[tickerIndex]!);

  return (
    <StatusBar
      {...rest}
      now={now}
      ticker={ticker}
      nextEventHours={nextEventHours}
      secondaryClock={
        <SecondaryClock
          locale={rest.locale}
          now={now}
          tz={secondaryTz}
          onSelectTz={handleSelectTz}
          onClear={handleClearTz}
        />
      }
    />
  );
}
