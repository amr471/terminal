/**
 * Alert rule model (CLAUDE.md §6.5, P1.12): a deterministic condition tree
 * evaluated by the alert-engine against live streams. Stored in `alerts.rule`.
 * No LLM in the evaluation path.
 */
import type { Dec, Exchange, Timeframe } from './market.js';

export const ALERT_CHANNELS = ['web', 'telegram'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/** Price crosses/compares against a level. */
export interface PriceCondition {
  kind: 'price';
  exchange: Exchange | string;
  symbol: string;
  op: 'crosses_above' | 'crosses_below' | 'gte' | 'lte';
  level: Dec;
}

/** Indicator threshold (indicator values computed deterministically by quant). */
export interface IndicatorCondition {
  kind: 'indicator';
  exchange: Exchange | string;
  symbol: string;
  tf: Timeframe;
  /** e.g. 'rsi_14', 'ema_50' — registry grows with P1.8/P1.15. */
  indicator: string;
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'crosses_above' | 'crosses_below';
  value: Dec;
}

/** Price approaches a liquidation cluster (from the liq map, §6.3). */
export interface LiqLevelCondition {
  kind: 'liq_level';
  symbol: string;
  /** Fire when price comes within this fraction of a cluster, e.g. '0.005' = 0.5%. */
  proximity: Dec;
  minClusterUsd?: Dec;
}

/** News event matching (evaluated against evt.news_scored, still deterministic). */
export interface NewsCondition {
  kind: 'news';
  /** Match any of these normalized asset tags, e.g. ['btc','eth']. */
  assets?: string[];
  minRelevance?: number; // 0..1
  sentiment?: 'bullish' | 'bearish' | 'any';
}

export interface AlertGroup {
  kind: 'group';
  logic: 'and' | 'or';
  children: AlertNode[];
}

export type AlertNode =
  PriceCondition | IndicatorCondition | LiqLevelCondition | NewsCondition | AlertGroup;

/** `alerts.rule` JSONB shape. */
export interface AlertRule {
  version: 1;
  root: AlertNode;
}

/** Payload published on evt.alert_fired and shown in web/Telegram. */
export interface AlertFiredEvent {
  alertId: string;
  userId: string;
  firedAt: number; // ms epoch
  /** Snapshot of the values that satisfied the rule (for the history log). */
  snapshot: Record<string, Dec | string | number>;
  channels: AlertChannel[];
}

const ALERT_KINDS = ['price', 'indicator', 'liq_level', 'news', 'group'] as const;

/** Structural check; engine-side semantic validation happens at P1.12. */
export function isAlertNode(value: unknown, depth = 0): value is AlertNode {
  if (depth > 5 || typeof value !== 'object' || value === null) return false;
  const n = value as Record<string, unknown>;
  if (!(ALERT_KINDS as readonly string[]).includes(n.kind as string)) return false;
  if (n.kind === 'group') {
    return (
      (n.logic === 'and' || n.logic === 'or') &&
      Array.isArray(n.children) &&
      n.children.length > 0 &&
      n.children.every((c) => isAlertNode(c, depth + 1))
    );
  }
  return true;
}
