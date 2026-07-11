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

const WEEKEND = new Set(['Sat', 'Sun']);

/** Is the given session open at this instant (Mon–Fri, local window)? */
export function isSessionOpen(session: TradingSession, date: Date = new Date()): boolean {
  const w = SESSION_WINDOWS[session];
  const { weekday, minutes } = zonedParts(date, w.tz);
  if (WEEKEND.has(weekday)) return false;
  return minutes >= w.openMin && minutes < w.closeMin;
}

export function activeSessions(date: Date = new Date()): TradingSession[] {
  return (Object.keys(SESSION_WINDOWS) as TradingSession[]).filter((s) => isSessionOpen(s, date));
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
