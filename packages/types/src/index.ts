/**
 * @terminal/types — shared type definitions used across web, gateway, and bots.
 * Source of truth for every cross-service contract; Go/Python mirrors are
 * generated from these shapes (tooling lands with the first consumer).
 */

export * from './market.js';
export * from './screener.js';
export * from './alerts.js';
export * from './strategy.js';
export * from './health.js';
export * from './errors.js';

/** Supported UI/LLM locales (CLAUDE.md §8 — RU/EN from the first commit). */
export type Locale = 'en' | 'ru';

export type AssetClass = 'crypto' | 'stock';

/** Canonical instrument identity, e.g. { symbol: 'BTCUSDT', exchange: 'binance' }. */
export interface Instrument {
  symbol: string;
  exchange: string;
  assetClass: AssetClass;
}

/** Trading sessions shown in the top status bar (fixed NY clock, CLAUDE.md §5). */
export type TradingSession = 'sydney' | 'tokyo' | 'london' | 'new_york';

export const TRADING_SESSIONS: readonly TradingSession[] = [
  'sydney',
  'tokyo',
  'london',
  'new_york',
] as const;

export function isLocale(value: string): value is Locale {
  return value === 'en' || value === 'ru';
}
