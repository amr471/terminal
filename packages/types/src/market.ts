/**
 * Market-data contract: Redis message envelope, payloads, and channel naming.
 * Mirrors /docs/architecture.md §4 — that document is the spec; this file is
 * the single source of truth for code (Go/Python mirrors are generated later).
 */

/**
 * String-encoded decimal (architecture.md §4.3). Prices/quantities/rates travel
 * as strings end to end; parse to a decimal type only inside computation kernels.
 * Never `parseFloat` a `Dec` in display or transport code.
 */
export type Dec = string;

/** Loose runtime shape check for a Dec (optionally signed, optional fraction). */
export function isDec(value: unknown): value is Dec {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
}

// The live market-data venues (services/market-data/internal/exchange's
// registry — one instrument_state.exchange value per adapter). Grew from the
// original three (F0.4) to all eight at P1.5b/P1.5d but this list was never
// updated to match, so `FilterBuilder`'s "exchange" filter dropdown silently
// couldn't select kucoin/aster/mexc/bingx even though real data existed for
// them (found 2026-07-17, reported as "not all coins are there" — the
// Screener's own filter builder was the thing under-representing venues, not
// the underlying data). `Exchange` is a plain string union (every consumer
// types it as `Exchange | string`, never exhaustively switched on), so
// widening this list is additive and can't break existing callers.
// 'coinglass' deliberately isn't here — it's a bought data vendor
// (CLAUDE.md §7), never an `instrument_state.exchange` value, so it never
// belonged in a screener-filterable exchange list.
export const EXCHANGES = [
  'binance',
  'bybit',
  'okx',
  'hyperliquid',
  'kucoin',
  'aster',
  'mexc',
  'bingx',
] as const;
export type Exchange = (typeof EXCHANGES)[number];

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const MESSAGE_TYPES = ['trade', 'book', 'candle', 'funding', 'oi', 'liq', 'ticker'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Envelope for every message on `md.*` and `evt.*` (architecture.md §4.2). */
export interface Envelope<T> {
  /** Envelope version. */
  v: 1;
  /** Payload type; matches the channel suffix. */
  type: MessageType;
  /** Origin feed. */
  src: Exchange | string;
  /** Normalized lowercase symbol, e.g. 'btcusdt'. Omitted where N/A. */
  sym?: string;
  /** Event time at the exchange, ms epoch. */
  ts: number;
  /** Receive time on our side, ms epoch. `rts - ts` = feed lag. */
  rts: number;
  /** Per-publisher, per-channel monotonic sequence; resets on publisher restart. */
  seq: number;
  data: T;
}

export interface TradePayload {
  price: Dec;
  qty: Dec;
  side: 'buy' | 'sell';
  /** Exchange trade id when provided. */
  id?: string;
}

/** L2 delta or snapshot. Price levels are [price, qty] tuples; qty '0' deletes. */
export interface BookPayload {
  bids: [Dec, Dec][];
  asks: [Dec, Dec][];
  /** True for full snapshots (consumers replace local state). */
  snapshot?: boolean;
  /** Exchange book sequence for gap detection (architecture.md §5.3). */
  bookSeq?: number;
}

export interface CandlePayload {
  tf: Timeframe;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
  volume: Dec;
  quoteVolume?: Dec;
  tradeCount?: number;
  /** True once the bucket is closed. */
  final?: boolean;
}

export interface FundingPayload {
  rate: Dec;
  nextFundingTs?: number;
}

export interface OiPayload {
  openInterest: Dec;
  openInterestUsd?: Dec;
}

export interface LiqPayload {
  /** Position side that was liquidated. */
  side: 'long' | 'short';
  price: Dec;
  qty: Dec;
  qtyUsd?: Dec;
}

export function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    e.v === 1 &&
    typeof e.type === 'string' &&
    (MESSAGE_TYPES as readonly string[]).includes(e.type) &&
    typeof e.src === 'string' &&
    typeof e.ts === 'number' &&
    typeof e.rts === 'number' &&
    typeof e.seq === 'number' &&
    'data' in e
  );
}

// ── Channel naming (architecture.md §4.1) ────────────────────────────────────

export interface MdChannel {
  exchange: string;
  symbol: string;
  kind: 'trades' | 'book' | 'candles' | 'funding' | 'oi';
  /** Present iff kind === 'candles'. */
  tf?: Timeframe;
}

/** Build a `md.{exchange}.{symbol}.{stream}` channel name. */
export function mdChannel(c: MdChannel): string {
  const base = `md.${c.exchange}.${c.symbol}.${c.kind}`;
  return c.kind === 'candles' ? `${base}.${c.tf ?? '1m'}` : base;
}

/** Parse a `md.*` channel name; returns null when malformed. */
export function parseMdChannel(name: string): MdChannel | null {
  const parts = name.split('.');
  if (parts[0] !== 'md') return null;
  const exchange = parts[1];
  const symbol = parts[2];
  const kind = parts[3];
  if (exchange === undefined || symbol === undefined || kind === undefined) return null;
  if (parts.length === 4) {
    if (kind === 'trades' || kind === 'book' || kind === 'funding' || kind === 'oi') {
      return { exchange, symbol, kind };
    }
    return null;
  }
  if (parts.length === 5 && kind === 'candles') {
    const tf = parts[4];
    if (tf === undefined || !(TIMEFRAMES as readonly string[]).includes(tf)) return null;
    return { exchange, symbol, kind: 'candles', tf: tf as Timeframe };
  }
  return null;
}

/** Durable event streams (Redis Streams, architecture.md §4.1). */
export const EVENT_STREAMS = [
  'evt.liq',
  'evt.funding',
  'evt.news_raw',
  'evt.news_scored',
  'evt.alert_fired',
  'evt.backtest_req',
  'evt.backtest_done',
  'evt.strategy_spec',
  'evt.journal_entry',
  'evt.audit',
] as const;
export type EventStream = (typeof EVENT_STREAMS)[number];
