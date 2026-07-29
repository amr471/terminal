/**
 * @terminal/i18n — RU/EN catalogs, translator, locale-aware formatting, and
 * the two clocks (user timezone vs fixed market-session clock).
 * No hardcoded user-facing strings anywhere else (CLAUDE.md §8).
 */
import type { Locale } from '@terminal/types';

export const DEFAULT_LOCALE: Locale = 'en';
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ru'] as const;

/** Best-effort locale negotiation from an Accept-Language header or tag list. */
export function negotiateLocale(input: string | undefined): Locale {
  if (!input) return DEFAULT_LOCALE;
  for (const raw of input.split(',')) {
    const tag = (raw.split(';')[0] ?? '').trim().toLowerCase();
    const base = tag.split('-')[0] ?? '';
    if (base === 'ru') return 'ru';
    if (base === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}

export {
  en,
  type Catalog,
  type Message,
  type MessageKey,
  type PluralForms,
} from './catalogs/en.js';
export { ru } from './catalogs/ru.js';
export { CATALOGS, t, type TranslateParams } from './translate.js';
export {
  formatDec,
  formatPercentFromFraction,
  formatCompact,
  roundDec,
  shiftDec,
  type FormatDecOptions,
} from './format.js';
export { formatDateTime, formatTime, formatAge, isValidTimezone } from './time.js';
export {
  SESSION_WINDOWS,
  isSessionOpen,
  activeSessions,
  sessionOverlaps,
  isMarketWeekend,
  nyClock,
  type SessionWindow,
  type NyClock,
} from './sessions.js';
