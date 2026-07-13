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
 * This only covers the clock (and, as a side effect, the session
 * active/overlap highlighting, since both are derived from the same `now`).
 * The live-news ticker and "next high-impact event" chip are separate,
 * larger pieces of P1.4 that depend on data sources that don't exist yet
 * (P1.9 news pipeline, P1.11 economic calendar) — not addressed here.
 */
import { useEffect, useState } from 'react';
import { StatusBar, type StatusBarProps } from '@terminal/ui';

export interface LiveStatusBarProps extends Omit<StatusBarProps, 'now'> {
  /** Request-time timestamp (ISO), used only to seed the first paint. */
  initialNowIso: string;
}

export function LiveStatusBar({ initialNowIso, ...rest }: LiveStatusBarProps) {
  const [now, setNow] = useState(() => new Date(initialNowIso));

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return <StatusBar {...rest} now={now} />;
}
