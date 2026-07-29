/**
 * Screener filter model (CLAUDE.md §6.1, P1.6): a deterministic
 * field·operator·value tree with AND/OR groups. The query engine executes
 * exactly this structure — the LLM may PRODUCE one from natural language,
 * but never sits in the execution path.
 */
import { isDec, EXCHANGES, type Dec } from './market.js';

export const SCREENER_FIELDS = [
  'price',
  'change_1h',
  'change_24h',
  'change_7d',
  'volume_24h',
  'market_cap',
  'open_interest',
  'funding_rate',
  'volatility_24h',
  'spread',
] as const;
export type ScreenerField = (typeof SCREENER_FIELDS)[number];

/**
 * How a numeric field should be TYPED by a human, versus how it is STORED.
 *
 * This exists because of a real footgun (2026-07-26): every `change_*` field,
 * `funding_rate`, `volatility_24h` and `spread` is stored as a FRACTION
 * (`0.10` = 10%), matching `instrument_state`'s convention. A trader typing
 * "10" into a "24h %" filter means ten percent and silently gets a thousand
 * percent — a filter that matches nothing, with no error to explain why.
 *
 *  - 'percent' — shown/typed as percent, stored as a fraction (÷100).
 *  - 'money'   — large USD figures; accepts K/M/B shorthand so `volume > 100M`
 *                doesn't require counting zeros.
 *  - 'plain'   — typed exactly as stored (prices, open interest counts).
 */
export const SCREENER_FIELD_UNITS: Record<ScreenerField, 'percent' | 'money' | 'plain'> = {
  price: 'plain',
  change_1h: 'percent',
  change_24h: 'percent',
  change_7d: 'percent',
  volume_24h: 'money',
  market_cap: 'money',
  open_interest: 'plain',
  funding_rate: 'percent',
  volatility_24h: 'percent',
  spread: 'percent',
};

const SHORTHAND: Record<string, number> = { k: 3, m: 6, b: 9 };

/**
 * Converts what a user typed into the Dec the kernel compares against.
 * Returns null when the input isn't a usable number, so the caller can leave
 * the previous value alone rather than storing garbage.
 *
 * Decimal-string arithmetic throughout — no float64 (architecture.md §4.3).
 * Scaling is done by moving the decimal point, so `0.1%` -> `0.001` exactly,
 * with none of the 0.1+0.2 nonsense a float round-trip would introduce.
 */
export function filterInputToDec(raw: string, unit: 'percent' | 'money' | 'plain'): Dec | null {
  let s = raw.trim().replace(/[,\s_]/g, '');
  if (s === '' || s === '-' || s === '+') return null;
  let shift = 0;
  if (s.endsWith('%')) s = s.slice(0, -1);
  const suffix = s.slice(-1).toLowerCase();
  if (unit === 'money' && SHORTHAND[suffix] !== undefined) {
    shift = SHORTHAND[suffix] ?? 0;
    s = s.slice(0, -1);
  }
  if (unit === 'percent') shift -= 2; // 10 -> 0.10
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return shiftDecimalString(s, shift);
}

/** Renders a stored Dec back into the unit the user types in. */
export function decToFilterInput(value: Dec, unit: 'percent' | 'money' | 'plain'): string {
  if (unit !== 'percent') return value;
  return shiftDecimalString(value, 2) ?? value;
}

/**
 * Moves a decimal string's point by `shift` places (positive = larger).
 * Pure string surgery so exactness is preserved at any magnitude.
 */
function shiftDecimalString(input: string, shift: number): Dec | null {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(input);
  if (!m) return null;
  const sign = m[1] === '-' ? '-' : '';
  let intPart = m[2] ?? '';
  let fracPart = m[3] ?? '';
  if (intPart === '' && fracPart === '') return null;
  if (shift > 0) {
    const take = Math.min(shift, fracPart.length);
    intPart += fracPart.slice(0, take) + '0'.repeat(shift - take);
    fracPart = fracPart.slice(take);
  } else if (shift < 0) {
    const n = -shift;
    const take = Math.min(n, intPart.length);
    fracPart = '0'.repeat(n - take) + intPart.slice(intPart.length - take) + fracPart;
    intPart = intPart.slice(0, intPart.length - take);
  }
  intPart = intPart.replace(/^0+(?=\d)/, '') || '0';
  fracPart = fracPart.replace(/0+$/, '');
  const out = fracPart === '' ? intPart : `${intPart}.${fracPart}`;
  return out === '0' ? '0' : sign + out; // never "-0"
}

export const NUMERIC_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'between'] as const;
export type NumericOp = (typeof NUMERIC_OPS)[number];

export const CATEGORICAL_FIELDS = ['exchange', 'asset_class'] as const;
export type CategoricalField = (typeof CATEGORICAL_FIELDS)[number];

export interface NumericCondition {
  kind: 'numeric';
  field: ScreenerField;
  op: NumericOp;
  /** Single Dec, or [low, high] when op === 'between'. */
  value: Dec | [Dec, Dec];
}

export interface CategoricalCondition {
  kind: 'categorical';
  field: CategoricalField;
  op: 'in' | 'not_in';
  values: string[];
}

export interface FilterGroup {
  kind: 'group';
  logic: 'and' | 'or';
  children: FilterNode[];
}

export type FilterNode = NumericCondition | CategoricalCondition | FilterGroup;

// Sortable fields: every numeric ScreenerField plus 'symbol' (added
// 2026-07-19 — an alphabetical view, requested alongside the volume-sort
// default). 'symbol' is a plain string compare in runScreen below, not
// compareDec — it was never a ScreenerField (that union is exact-decimal
// numeric fields only) and doesn't need to become one just to be sortable.
export const SCREENER_SORT_FIELDS = [...SCREENER_FIELDS, 'symbol'] as const;
export type ScreenerSortField = (typeof SCREENER_SORT_FIELDS)[number];

/** A saved screen definition (`screens.definition` JSONB). */
export interface ScreenDefinition {
  version: 1;
  root: FilterGroup;
  /** Default sort, e.g. { field: 'volume_24h', dir: 'desc' } — the primary use case. */
  sort?: { field: ScreenerSortField; dir: 'asc' | 'desc' };
  limit?: number;
}

export const MAX_FILTER_DEPTH = 5;
export const MAX_FILTER_NODES = 64;

/**
 * Structural validation with depth/size limits (defense against hostile or
 * LLM-malformed definitions). Returns a list of problems; empty = valid.
 */
export function validateFilterNode(node: unknown, depth = 0, budget = { nodes: 0 }): string[] {
  const errors: string[] = [];
  budget.nodes += 1;
  if (budget.nodes > MAX_FILTER_NODES) return [`node budget exceeded (${MAX_FILTER_NODES})`];
  if (depth > MAX_FILTER_DEPTH) return [`max depth exceeded (${MAX_FILTER_DEPTH})`];
  if (typeof node !== 'object' || node === null) return ['node is not an object'];
  const n = node as Record<string, unknown>;

  if (n.kind === 'group') {
    if (n.logic !== 'and' && n.logic !== 'or') errors.push('group.logic must be and|or');
    if (!Array.isArray(n.children) || n.children.length === 0) {
      errors.push('group.children must be a non-empty array');
    } else {
      for (const child of n.children) errors.push(...validateFilterNode(child, depth + 1, budget));
    }
    return errors;
  }

  if (n.kind === 'numeric') {
    if (!(SCREENER_FIELDS as readonly string[]).includes(n.field as string))
      errors.push(`unknown numeric field: ${String(n.field)}`);
    if (!(NUMERIC_OPS as readonly string[]).includes(n.op as string))
      errors.push(`unknown numeric op: ${String(n.op)}`);
    if (n.op === 'between') {
      const v = n.value;
      if (!Array.isArray(v) || v.length !== 2 || !isDec(v[0]) || !isDec(v[1]))
        errors.push('between requires [Dec, Dec]');
    } else if (!isDec(n.value)) {
      errors.push('value must be a Dec string');
    }
    return errors;
  }

  if (n.kind === 'categorical') {
    if (!(CATEGORICAL_FIELDS as readonly string[]).includes(n.field as string))
      errors.push(`unknown categorical field: ${String(n.field)}`);
    if (n.op !== 'in' && n.op !== 'not_in') errors.push('categorical op must be in|not_in');
    if (!Array.isArray(n.values) || n.values.some((v) => typeof v !== 'string'))
      errors.push('values must be string[]');
    return errors;
  }

  return [`unknown node kind: ${String(n.kind)}`];
}

export function isValidScreenDefinition(def: unknown): def is ScreenDefinition {
  if (typeof def !== 'object' || def === null) return false;
  const d = def as Record<string, unknown>;
  if (d.version !== 1) return false;
  return validateFilterNode(d.root).length === 0;
}

/**
 * One instrument's screenable state — the engine's view of an `instrument_state`
 * row. Numeric fields are `Dec | null` (null = not computed yet, e.g. derived
 * stats in the first 24h; a null never satisfies a numeric condition).
 */
export interface ScreenerRow {
  exchange: string;
  symbol: string;
  asset_class: string;
  price: Dec | null;
  change_1h: Dec | null;
  change_24h: Dec | null;
  change_7d: Dec | null;
  volume_24h: Dec | null;
  market_cap: Dec | null;
  open_interest: Dec | null;
  funding_rate: Dec | null;
  volatility_24h: Dec | null;
  spread: Dec | null;
}

function fracLen(dec: string): number {
  const dot = dec.indexOf('.');
  return dot < 0 ? 0 : dec.length - dot - 1;
}

// toScaled turns a Dec into an exact integer scaled to `scale` fraction digits.
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

/**
 * Exact comparison of two Dec strings — never float. Returns -1/0/1. Prices and
 * OI routinely exceed float precision; compare as scaled BigInts (architecture.md
 * §4.3: parse a Dec to a numeric type only inside a computation kernel — this is
 * that kernel).
 */
export function compareDec(a: Dec, b: Dec): number {
  const scale = Math.max(fracLen(a), fracLen(b));
  const av = toScaled(a, scale);
  const bv = toScaled(b, scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function evalNumeric(cond: NumericCondition, raw: Dec | null): boolean {
  if (raw === null || !isDec(raw)) return false; // missing value never matches
  if (cond.op === 'between') {
    const [lo, hi] = cond.value as [Dec, Dec];
    return compareDec(raw, lo) >= 0 && compareDec(raw, hi) <= 0;
  }
  const cmp = compareDec(raw, cond.value as Dec);
  switch (cond.op) {
    case 'gt':
      return cmp > 0;
    case 'gte':
      return cmp >= 0;
    case 'lt':
      return cmp < 0;
    case 'lte':
      return cmp <= 0;
    case 'eq':
      return cmp === 0;
    case 'neq':
      return cmp !== 0;
    default:
      return false;
  }
}

/**
 * Evaluate a validated FilterNode against one row. Deterministic, no LLM, no
 * SQL. Assumes the node passed `validateFilterNode`; an empty group is treated
 * as identity (and → true, or → false) rather than throwing.
 */
export function evaluateFilter(node: FilterNode, row: ScreenerRow): boolean {
  switch (node.kind) {
    case 'group':
      if (node.logic === 'and') return node.children.every((c) => evaluateFilter(c, row));
      return node.children.some((c) => evaluateFilter(c, row));
    case 'numeric':
      return evalNumeric(node, row[node.field]);
    case 'categorical': {
      const v = node.field === 'exchange' ? row.exchange : row.asset_class;
      const has = node.values.includes(v);
      return node.op === 'in' ? has : !has;
    }
    default:
      return false;
  }
}

/**
 * Run a full screen: filter the rows, sort (default volume_24h desc — the
 * primary use case), and apply the optional limit. Nulls always sort last
 * regardless of direction. Returns a new array; does not mutate the input.
 */
export function runScreen(def: ScreenDefinition, rows: ScreenerRow[]): ScreenerRow[] {
  const matched = rows.filter((r) => evaluateFilter(def.root, r));
  const field: ScreenerSortField = def.sort?.field ?? 'volume_24h';
  const dir = def.sort?.dir ?? 'desc';
  matched.sort((a, b) => {
    if (field === 'symbol') {
      // Plain codepoint compare, not localeCompare: symbols are always
      // ASCII tickers, and a fixed comparison is deterministic across
      // locales/ICU versions — same "exact, no surprise" stance compareDec
      // takes for numeric fields. symbol is never null, so no nulls-last
      // branch is needed here.
      const cmp = a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
      return dir === 'asc' ? cmp : -cmp;
    }
    const av = a[field];
    const bv = b[field];
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls last
    if (bv === null) return -1;
    const cmp = compareDec(av, bv);
    return dir === 'asc' ? cmp : -cmp;
  });
  if (def.limit && def.limit > 0) return matched.slice(0, def.limit);
  return matched;
}

/**
 * Collapses rows to one per symbol using a STRICT venue-priority order: for
 * each symbol, the earliest venue in `priority` that lists it wins. Revised
 * 2026-07-26, when `priority` became a user-chosen list (the Screener's
 * venue-priority picker) — "I want the user to select the priority of the
 * exchanges from which prices and values are displayed. Like if mexc, then
 * everything is on mexc, and if not, then something else."
 *
 * History worth knowing before changing this again: 2026-07-19 it worked the
 * other way — only `priority[0]` won outright and all other venues were ranked
 * by highest 24h volume — because the order was hardcoded and a fixed fallback
 * kept collapsing onto the same thin venue (John: "almost all coins are from
 * kucoin"). Volume was standing in for "pick the good venue." Now that the
 * order is the user's, that proxy is unwanted for ranked venues. Volume is
 * still the tie-break between venues NOT in `priority`, so an unranked venue
 * is sorted last rather than dropped. Client-side,
 * applied on top of the already-server-sorted `runScreen` output, not a
 * `ScreenDefinition` concern — the Screener's underlying rows stay one row
 * per (exchange, symbol) pair (docs/screener.md's discovery-use-case
 * design, unchanged), this just decides which of those rows to *display*
 * by default. Preserves the input array's relative order (the caller's
 * sort) rather than re-sorting — only the losing duplicate rows are
 * dropped, so a volume-desc sort stays volume-desc among the survivors.
 *
 * Every field in the returned row comes from that row's own exchange. A brief
 * cross-venue OI/funding fill (2026-07-23) was removed 2026-07-26 — see the
 * comment above `bestForSymbol` for why it conflicted with the priority picker
 * and made the table inconsistent under the exchange quick-pick.
 */
export function consolidateByVenuePreference(
  rows: ScreenerRow[],
  priority: readonly string[] = EXCHANGES,
): ScreenerRow[] {
  const rank = new Map<string, number>(priority.map((venue, i) => [venue, i]));
  const rankOf = (venue: string): number => rank.get(venue) ?? Number.POSITIVE_INFINITY;

  const isBetter = (candidate: ScreenerRow, current: ScreenerRow): boolean => {
    // STRICT priority order (revised 2026-07-26). `priority` is now a
    // user-chosen list (Screener's venue-priority picker), and the whole point
    // of choosing an order is that it's honored: "if mexc, then everything is
    // on mexc, and if not, then something else, and so on with all exchanges."
    // So a venue earlier in the list wins outright — not just index 0.
    //
    // This supersedes the 2026-07-19 rule where only priority[0] won outright
    // and every other venue was picked by highest 24h volume. That existed
    // because the order was HARDCODED, so a fixed fallback kept collapsing onto
    // the same thin venue; volume was a proxy for "pick the good one." With the
    // order under user control that proxy is no longer wanted for ranked
    // venues. Volume still decides between venues absent from the list, so an
    // unranked venue is never excluded — just sorted last.
    const rc = rankOf(candidate.exchange);
    const rr = rankOf(current.exchange);
    if (rc !== rr) return rc < rr;
    if (candidate.volume_24h !== null && current.volume_24h !== null) {
      const cmp = compareDec(candidate.volume_24h, current.volume_24h);
      if (cmp !== 0) return cmp > 0;
    } else if (candidate.volume_24h !== current.volume_24h) {
      // Exactly one side has a real volume — a known volume always beats
      // an unknown (null) one.
      return candidate.volume_24h !== null;
    }
    return false;
  };

  // NO cross-venue field borrowing (removed 2026-07-26). Every value in a row
  // comes from the exchange named in that row — full stop.
  //
  // A fill existed briefly (2026-07-23): when the winning row had no OI or
  // funding, it borrowed those two fields from another venue that did. It was
  // added to stop blank cells when the winner was a venue that emits neither.
  // Two problems killed it:
  //   1. It contradicts the venue-priority picker. "If mexc, then everything is
  //      on mexc" means the OI column must be MEXC's number, not a substitute
  //      from whichever other venue happened to have one.
  //   2. It made the table inconsistent with itself. The exchange quick-pick
  //      filters SERVER-side, so selecting one venue removes the donor rows —
  //      and open interest that was visible under "All exchanges" vanished when
  //      you picked that same exchange. John hit exactly this.
  // The honest answer to a blank cell is to make that venue actually report the
  // field (see docs/market-data-feeds.md P1.5e/P1.5f), not to paper over it
  // with a number from somewhere else.
  const bestForSymbol = new Map<string, ScreenerRow>();
  for (const row of rows) {
    const existing = bestForSymbol.get(row.symbol);
    if (!existing || isBetter(row, existing)) {
      bestForSymbol.set(row.symbol, row);
    }
  }
  return rows.filter((r) => bestForSymbol.get(r.symbol) === r);
}

/**
 * Bybit's TradFi tokenized-stock-perpetual naming convention:
 * `{TICKER}STOCKUSDT` (e.g. AMDSTOCKUSDT, AAPLSTOCKUSDT — verified against
 * Bybit's own listing announcements, 2026-07-19). A symbol-pattern
 * heuristic for today's quick filter, NOT the real `asset_class` field —
 * every `ScreenerRow.asset_class` is still hardcoded `"crypto"` server-side
 * (`services/market-data/internal/store/state.go`); teaching the store the
 * real distinction between crypto and equities is P1B.3 "Stocks surface"
 * (TASKS.md, unstarted, a genuinely new market-data source), not this.
 */
export function isStockToken(symbol: string): boolean {
  return symbol.toLowerCase().endsWith('stockusdt');
}

// ── Live WS wire contract (P1.7 UI) ─────────────────────────────────────────
// The gateway (services/api-gateway/src/ws.ts) constructs these frames ad hoc
// against docs/screener.md's documented shapes; these types are the frontend's
// side of that same contract so a parser has something to narrow against.
// Additive only — no gateway changes required to introduce this file.

/** Client -> gateway: run a screen live. Re-using an existing subId replaces
 * that subscription (docs/screener.md). Exactly one of definition/screenId. */
export type ScreenerSubscribeMessage =
  | { action: 'screener.subscribe'; subId: string; definition: ScreenDefinition }
  | { action: 'screener.subscribe'; subId: string; screenId: string };

export interface ScreenerUnsubscribeMessage {
  action: 'screener.unsubscribe';
  subId: string;
}

export interface ScreenerSnapshotFrame {
  type: 'screener.snapshot';
  subId: string;
  rows: ScreenerRow[];
}

/** `order` is the full current row order (by `exchange|symbol` key); added/
 * updated/removed carry only what changed since the subscriber's last frame. */
export interface ScreenerDeltaFrame {
  type: 'screener.delta';
  subId: string;
  added: ScreenerRow[];
  updated: ScreenerRow[];
  removed: string[];
  order: string[];
}

export interface ScreenerUnsubscribedFrame {
  type: 'screener.unsubscribed';
  subId: string;
}

export interface ScreenerErrorFrame {
  type: 'error';
  code: string;
  subId?: string;
  message?: string;
}

export type ScreenerServerFrame =
  ScreenerSnapshotFrame | ScreenerDeltaFrame | ScreenerUnsubscribedFrame | ScreenerErrorFrame;

/** `exchange|symbol` row key, matching the gateway's ScreenerHub (screenerHub.ts). */
export function screenerRowKey(r: Pick<ScreenerRow, 'exchange' | 'symbol'>): string {
  return `${r.exchange}|${r.symbol}`;
}

function isScreenerRow(value: unknown): value is ScreenerRow {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.exchange === 'string' &&
    typeof r.symbol === 'string' &&
    typeof r.asset_class === 'string'
  );
}

/** Runtime narrowing for a parsed WS text frame — never trust JSON.parse's
 * output past `unknown` (this is the browser, not a validated server input). */
export function isScreenerServerFrame(value: unknown): value is ScreenerServerFrame {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== 'string') return false;
  switch (v.type) {
    case 'screener.snapshot':
      return typeof v.subId === 'string' && Array.isArray(v.rows) && v.rows.every(isScreenerRow);
    case 'screener.delta':
      return (
        typeof v.subId === 'string' &&
        Array.isArray(v.added) &&
        v.added.every(isScreenerRow) &&
        Array.isArray(v.updated) &&
        v.updated.every(isScreenerRow) &&
        Array.isArray(v.removed) &&
        v.removed.every((x) => typeof x === 'string') &&
        Array.isArray(v.order) &&
        v.order.every((x) => typeof x === 'string')
      );
    case 'screener.unsubscribed':
      return typeof v.subId === 'string';
    case 'error':
      return typeof v.code === 'string';
    default:
      return false;
  }
}
