/**
 * Consolidated best-price model (P1.7b, CLAUDE.md §6.1's scalpboard.io-style
 * view): across every venue currently listing a symbol, the best bid/ask and
 * the top-of-book size available at that price, live. Deliberately a
 * different row shape from ScreenerRow (screener.ts) — the screener's
 * `instrument_state` rows are per (exchange, symbol), one venue per row;
 * this view is per symbol, one row per instrument, with the winning venue
 * folded in as a field. Both read the same underlying data, just grouped
 * differently.
 *
 * Order-book data lives only in Redis (`cache:book:{exchange}:{symbol}`,
 * schema.md §5's deliberate call — never persisted to Postgres), so unlike
 * the screener's `runScreen` kernel (a pure function over Postgres-sourced
 * rows), the consolidation math here runs in the gateway's BestPriceHub
 * (services/api-gateway/src/bestPriceHub.ts) against Redis reads directly.
 * Still no LLM, no float — exact scaled-BigInt decimal comparison
 * (`compareDec`, screener.ts) and arithmetic (`subtractDec`, this file).
 */
import { isDec, type Dec } from './market.js';

/** One consolidated instrument row: best bid/ask across every venue that
 * currently has book data for this symbol. A `null` price means no venue
 * currently has a live top-of-book for that side (feed down / not yet
 * warmed up) — never treated as zero. */
export interface BestPriceRow {
  symbol: string;
  assetClass: string;
  bestBid: Dec | null;
  bestBidSize: Dec | null;
  bestBidVenue: string | null;
  bestAsk: Dec | null;
  bestAskSize: Dec | null;
  bestAskVenue: string | null;
  /** bestAsk - bestBid, exact decimal subtraction; null unless both sides are present. */
  spread: Dec | null;
  /** How many venues currently contribute a top-of-book for this symbol. */
  venueCount: number;
}

/** `symbol` alone identifies a row here (unlike screener's `exchange|symbol` —
 * this view is already consolidated across venues). */
export function bestPriceRowKey(r: Pick<BestPriceRow, 'symbol'>): string {
  return r.symbol;
}

function fracLen(dec: string): number {
  const dot = dec.indexOf('.');
  return dot < 0 ? 0 : dec.length - dot - 1;
}

function toScaled(dec: string, scale: number): bigint {
  let s = dec;
  let neg = false;
  if (s[0] === '-') {
    neg = true;
    s = s.slice(1);
  } else if (s[0] === '+') {
    s = s.slice(1);
  }
  const dot = s.indexOf('.');
  const intPart = dot < 0 ? s : s.slice(0, dot);
  const fracPart = dot < 0 ? '' : s.slice(dot + 1);
  const frac = (fracPart + '0'.repeat(scale)).slice(0, scale);
  const v = BigInt((intPart === '' ? '0' : intPart) + frac);
  return neg ? -v : v;
}

function fromScaled(v: bigint, scale: number): Dec {
  const neg = v < 0n;
  const abs = (neg ? -v : v).toString().padStart(scale + 1, '0');
  const intPart = abs.slice(0, abs.length - scale) || '0';
  // Trim trailing zero fraction digits (and the dot itself if nothing's
  // left) for a canonical display value — this is a terminal result (spread
  // shown to the user), not an intermediate fed back into more decimal math,
  // so normalizing here can't accumulate precision loss.
  const fracPart = scale > 0 ? abs.slice(abs.length - scale).replace(/0+$/, '') : '';
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  if (out === '0') return '0'; // never render a signed zero
  return neg ? `-${out}` : out;
}

/**
 * Exact `a - b` over Dec strings, never float (architecture.md §4.3) — the
 * same scaled-BigInt approach `compareDec` (screener.ts) uses for
 * comparison, duplicated here rather than shared: each module's decimal
 * helpers stay private and self-contained, same precedent screener.ts set.
 */
export function subtractDec(a: Dec, b: Dec): Dec {
  const scale = Math.max(fracLen(a), fracLen(b));
  const diff = toScaled(a, scale) - toScaled(b, scale);
  return fromScaled(diff, scale);
}

// ── Live WS wire contract ────────────────────────────────────────────────
// Mirrors screener.ts's own "Live WS wire contract" section: the gateway
// (services/api-gateway/src/ws.ts) constructs these frames ad hoc against
// docs/best-price.md's documented shapes; these types are the frontend's
// side of that contract. No filter/definition concept here — every
// subscriber sees the same consolidated rows, so (unlike screener) there's
// nothing to pass beyond a subId.

export interface BestPriceSubscribeMessage {
  action: 'bestprice.subscribe';
  subId: string;
}

export interface BestPriceUnsubscribeMessage {
  action: 'bestprice.unsubscribe';
  subId: string;
}

export interface BestPriceSnapshotFrame {
  type: 'bestprice.snapshot';
  subId: string;
  rows: BestPriceRow[];
}

/** `order` is the full current row order (by `symbol`); added/updated/removed
 * carry only what changed since the subscriber's last frame — same shape as
 * ScreenerDeltaFrame. */
export interface BestPriceDeltaFrame {
  type: 'bestprice.delta';
  subId: string;
  added: BestPriceRow[];
  updated: BestPriceRow[];
  removed: string[];
  order: string[];
}

export interface BestPriceUnsubscribedFrame {
  type: 'bestprice.unsubscribed';
  subId: string;
}

export interface BestPriceErrorFrame {
  type: 'error';
  code: string;
  subId?: string;
  message?: string;
}

export type BestPriceServerFrame =
  | BestPriceSnapshotFrame
  | BestPriceDeltaFrame
  | BestPriceUnsubscribedFrame
  | BestPriceErrorFrame;

function isNullableDec(value: unknown): value is Dec | null {
  return value === null || isDec(value);
}

function isBestPriceRow(value: unknown): value is BestPriceRow {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.symbol === 'string' &&
    typeof r.assetClass === 'string' &&
    isNullableDec(r.bestBid) &&
    isNullableDec(r.bestBidSize) &&
    (r.bestBidVenue === null || typeof r.bestBidVenue === 'string') &&
    isNullableDec(r.bestAsk) &&
    isNullableDec(r.bestAskSize) &&
    (r.bestAskVenue === null || typeof r.bestAskVenue === 'string') &&
    isNullableDec(r.spread) &&
    typeof r.venueCount === 'number'
  );
}

/** Runtime narrowing for a parsed WS text frame — never trust JSON.parse's
 * output past `unknown` (same stance isScreenerServerFrame takes). */
export function isBestPriceServerFrame(value: unknown): value is BestPriceServerFrame {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') return false;
  switch (v.type) {
    case 'bestprice.snapshot':
      return typeof v.subId === 'string' && Array.isArray(v.rows) && v.rows.every(isBestPriceRow);
    case 'bestprice.delta':
      return (
        typeof v.subId === 'string' &&
        Array.isArray(v.added) &&
        v.added.every(isBestPriceRow) &&
        Array.isArray(v.updated) &&
        v.updated.every(isBestPriceRow) &&
        Array.isArray(v.removed) &&
        v.removed.every((x) => typeof x === 'string') &&
        Array.isArray(v.order) &&
        v.order.every((x) => typeof x === 'string')
      );
    case 'bestprice.unsubscribed':
      return typeof v.subId === 'string';
    case 'error':
      return typeof v.code === 'string';
    default:
      return false;
  }
}
