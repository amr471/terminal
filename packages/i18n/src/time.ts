/**
 * USER-timezone date/time display. Deliberately separate from sessions.ts:
 * the user's clock follows their IANA zone preference; the market-session
 * clock is fixed to exchange-local timezones and never follows the user
 * (CLAUDE.md §5/§8).
 */
import type { Locale } from '@terminal/types';

/** Format an instant in the user's timezone, e.g. '15 Jul 2026, 14:03'. */
export function formatDateTime(tsMs: number, locale: Locale, tz: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(tsMs));
}

/** Time-only, e.g. '14:03:27'. */
export function formatTime(tsMs: number, locale: Locale, tz: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(tsMs));
}

/**
 * Is `tz` a real IANA zone name? Guards against a stale/corrupted stored
 * preference (P1.4a's secondary clock) before it ever reaches
 * Intl.DateTimeFormat, which throws RangeError on an invalid zone.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const AGE_UNITS: Record<Locale, { s: string; m: string; h: string; d: string }> = {
  en: { s: 's', m: 'm', h: 'h', d: 'd' },
  ru: { s: 'с', m: 'мин', h: 'ч', d: 'д' },
};

/** Compact age for stale-data badges (architecture.md §5.6): '12s', '3мин'. */
export function formatAge(ageMs: number, locale: Locale): string {
  const u = AGE_UNITS[locale];
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return `${s}${u.s}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}${u.m}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${u.h}`;
  return `${Math.floor(h / 24)}${u.d}`;
}
