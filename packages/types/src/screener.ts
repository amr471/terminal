/**
 * Screener filter model (CLAUDE.md §6.1, P1.6): a deterministic
 * field·operator·value tree with AND/OR groups. The query engine executes
 * exactly this structure — the LLM may PRODUCE one from natural language,
 * but never sits in the execution path.
 */
import { isDec, type Dec } from './market.js';

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

/** A saved screen definition (`screens.definition` JSONB). */
export interface ScreenDefinition {
  version: 1;
  root: FilterGroup;
  /** Default sort, e.g. { field: 'volume_24h', dir: 'desc' } — the primary use case. */
  sort?: { field: ScreenerField; dir: 'asc' | 'desc' };
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
  const field: ScreenerField = def.sort?.field ?? 'volume_24h';
  const dir = def.sort?.dir ?? 'desc';
  matched.sort((a, b) => {
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
