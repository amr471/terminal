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
