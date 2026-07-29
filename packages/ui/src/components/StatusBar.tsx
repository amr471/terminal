/**
 * Top status bar shell (CLAUDE.md §5) — the daily-retention hook:
 * NY time (auto EST/EDT), session strip with overlaps, a live-news ticker
 * slot, and the "next high-impact event" chip. Fixed session clock; the
 * user's timezone plays no role here.
 */
import type { ReactNode } from 'react';
import type { Locale, TradingSession } from '@terminal/types';
import { TRADING_SESSIONS } from '@terminal/types';
import { t, nyClock, activeSessions, sessionOverlaps, isMarketWeekend } from '@terminal/i18n';

export interface StatusBarProps {
  locale: Locale;
  /** Injected for renderability/tests; defaults to now. Re-render once per second upstream. */
  now?: Date;
  /** Live-news ticker content (marquee lands with P1.4 wiring). */
  ticker?: ReactNode;
  /** Hours until the next high-impact event; chip hidden when undefined. */
  nextEventHours?: number;
  /**
   * User-selectable secondary clock (P1.4a), rendered next to the fixed NY
   * clock. StatusBar stays agnostic of what it renders or how its selection
   * is persisted — same escape-hatch pattern as `ticker` above. Typically a
   * `<SecondaryClock>` from this package, wired up by a stateful caller
   * (apps/web's LiveStatusBar).
   */
  secondaryClock?: ReactNode;
}

const SESSION_LABEL_KEY = {
  sydney: 'status.session.sydney',
  tokyo: 'status.session.tokyo',
  london: 'status.session.london',
  new_york: 'status.session.new_york',
} as const;

export function StatusBar({
  locale,
  now = new Date(),
  ticker,
  nextEventHours,
  secondaryClock,
}: StatusBarProps) {
  const clock = nyClock(now);
  const open = new Set<TradingSession>(activeSessions(now));
  const overlapping = new Set<TradingSession>(sessionOverlaps(now).flat());
  const isWeekend = isMarketWeekend(now);

  return (
    <div className="t-statusbar" role="banner">
      <span className="t-statusbar__clock t-num" title={t(locale, 'status.ny_time')}>
        {clock.time}
        <span className="t-statusbar__tz">{clock.abbreviation}</span>
      </span>

      {secondaryClock !== undefined && (
        <div className="t-statusbar__secondary-clock">{secondaryClock}</div>
      )}

      <ul className="t-statusbar__sessions">
        {TRADING_SESSIONS.map((s) => {
          const state = overlapping.has(s) ? 'overlap' : open.has(s) ? 'active' : 'inactive';
          return (
            <li key={s} className={`t-session t-session--${state}`}>
              {t(locale, SESSION_LABEL_KEY[s])}
            </li>
          );
        })}
      </ul>

      {/* Two independent states since 2026-07-26 (John's call):
          - The hour bands above highlight 24/7 (crypto never stops), so a
            weekend no longer blanks the strip.
          - `isWeekend` still marks that EQUITIES/FX are shut, so a lit New York
            band on a Sunday isn't mistaken for an open equities session.
          - `open.size === 0` is now only a genuine between-bands gap. */}
      {isWeekend ? (
        <span className="t-statusbar__sessions-closed" data-weekend>
          {t(locale, 'status.session.weekend')}
        </span>
      ) : (
        open.size === 0 && (
          <span className="t-statusbar__sessions-closed">
            {t(locale, 'status.session.all_closed')}
          </span>
        )
      )}

      <div className="t-statusbar__ticker">{ticker}</div>

      {nextEventHours !== undefined && (
        <span className="t-statusbar__event-chip">
          {t(locale, 'status.next_event', { hours: nextEventHours })}
        </span>
      )}
    </div>
  );
}
