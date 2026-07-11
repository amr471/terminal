/**
 * @terminal/i18n — RU/EN locale catalogs + helpers.
 * Scaffolding only; the real framework wiring (next-intl) and the full
 * formatting utilities (numbers, dates, user-timezone vs fixed NY clock)
 * land in F0.4. No hardcoded user-facing strings anywhere else (CLAUDE.md §8).
 */
import type { Locale } from '@terminal/types';

export const DEFAULT_LOCALE: Locale = 'en';
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'ru'] as const;
