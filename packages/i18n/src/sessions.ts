/**
 * FIXED market-session clock (CLAUDE.md §5): the top status bar shows New York
 * time and the Sydney/Tokyo/London/New York session strip. Sessions are
 * defined in their own exchange-local timezones, so DST in each region is
 * handled by the zone database, not by us. THE USER'S TIMEZONE PLAYS NO ROLE
 * HERE — user-local display lives in time.ts.
 */
import type { TradingSession } from '@terminal/types';

export interface SessionWindow {
  tz: string;
  /** Local open/close in minutes from midnight, [open, close). */
  openMin: number;
  closeMin: number;
}

/** Conventional dealing-desk hours in each hub's local time. */
export const SESSION_WINDOWS: Record<TradingSession, SessionWindow> = {
  sydney: { tz: 'Australia/Sydney', openMin: 7 * 60, closeMin: 16 * 60 },
  tokyo: { tz: 'Asia/Tokyo', openMin: 9 * 60, closeMin: 18 * 60 },
  london: { tz: 'Europe/London', openMin: 8 * 60, closeMin: 17 * 60 },
  new_york: { tz: 'America/New_York', openMin: 8 * 60, closeMin: 17 * 60 },
};

interface ZonedParts {
  weekday: string; // 'Mon'..'Sun'
  minutes: number; // minutes from local midnight
}

function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // 'hour' is '24' at midnight in some ICU versions with hour12:false; normalize.
  const hour = Number(get('hour')) % 24;
  return { weekday: get('weekday'), minutes: hour * 60 + Number(get('minute')) };
}

/**
 * Is the given session's HOUR BAND active at this instant?
 *
 * Deliberately 24/7 — the weekday is NOT considered (John, 2026-07-26). This
 * is a crypto-first terminal: crypto trades through the weekend, and its
 * liquidity still follows the regional hours these bands mark, so a strip that
 * goes fully dim Sat/Sun is dead weight exactly when a crypto trader is
 * looking at it. Equities/FX being shut is surfaced separately by
 * isMarketWeekend() rather than by blanking the whole strip.
 */
export function isSessionOpen(session: TradingSession, date: Date = new Date()): boolean {
  const w = SESSION_WINDOWS[session];
  const { minutes } = zonedParts(date, w.tz);
  return minutes >= w.openMin && minutes < w.closeMin;
}

export function activeSessions(date: Date = new Date()): TradingSession[] {
  return (Object.keys(SESSION_WINDOWS) as TradingSession[]).filter((s) => isSessionOpen(s, date));
}

/**
 * True during the FX/equities weekend closure. Since isSessionOpen went 24/7,
 * this no longer dims the session bands — it drives a separate marker saying
 * **equities and FX** are shut while the hour band is lit and crypto trades on.
 *
 * Uses the industry-standard FX weekend window, expressed in New York time:
 * from Friday's 17:00 NY close to Sunday's 17:00 NY reopen (Sydney's Monday
 * morning). A naive "is it Sat/Sun somewhere" check gets this wrong in both
 * directions, because the hubs straddle the dateline — at Sunday 12:57 NY it's
 * already Monday in Sydney, yet the market is very much still shut.
 */
export function isMarketWeekend(date: Date = new Date()): boolean {
  const { weekday, minutes } = zonedParts(date, SESSION_WINDOWS.new_york.tz);
  const reopen = 17 * 60; // Sunday 17:00 NY — Sydney's Monday open
  if (weekday === 'Sat') return true;
  if (weekday === 'Fri') return minutes >= reopen;
  if (weekday === 'Sun') return minutes < reopen;
  return false;
}

/** Pairs of simultaneously open sessions — the high-liquidity overlap markers. */
export function sessionOverlaps(date: Date = new Date()): [TradingSession, TradingSession][] {
  const open = activeSessions(date);
  const pairs: [TradingSession, TradingSession][] = [];
  for (const [i, a] of open.entries()) {
    for (const b of open.slice(i + 1)) pairs.push([a, b]);
  }
  return pairs;
}

export interface NyClock {
  /** 'HH:MM:SS' in America/New_York. */
  time: string;
  /** 'EST' or 'EDT' — auto-switching (CLAUDE.md §5). */
  abbreviation: string;
}

/** The status-bar New York clock. */
export function nyClock(date: Date = new Date()): NyClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = String(Number(get('hour')) % 24).padStart(2, '0');
  return {
    time: `${hour}:${get('minute')}:${get('second')}`,
    abbreviation: get('timeZoneName'),
  };
}
