/**
 * Strategy spec skeleton (CLAUDE.md §6.2, P1.15/P1.16): the structured output
 * of NL → strategy that the backtest engine executes deterministically.
 * Stored in `strategies.spec`; frozen into `backtests.spec_snapshot` per run.
 * One agent = one strategy.
 */
import type { Dec, Exchange, Timeframe } from './market.js';
import type { AlertNode } from './alerts.js';

export interface StrategyUniverse {
  exchanges: (Exchange | string)[];
  /** Explicit symbols, or a screen id whose result set defines the universe. */
  symbols?: string[];
  screenId?: string;
}

export interface StrategyRisk {
  /** Fraction of equity per position, e.g. '0.02' = 2%. */
  maxPositionPct: Dec;
  maxConcurrentPositions: number;
  /** Hard stop for the whole strategy, fraction of equity. */
  maxDrawdownPct?: Dec;
}

export interface StrategyExit {
  takeProfitPct?: Dec;
  stopLossPct?: Dec;
  /** Optional condition-tree exit (same node model as alerts). */
  rule?: AlertNode;
  /** Bars to hold at most (0 = unlimited). */
  maxHoldBars?: number;
}

/** `strategies.spec` JSONB shape. Grows with P1.15/P1.16; version-gated. */
export interface StrategySpec {
  version: 1;
  name: string;
  universe: StrategyUniverse;
  tf: Timeframe;
  side: 'long' | 'short' | 'both';
  /** Entry condition tree (same deterministic node model as alerts). */
  entry: AlertNode;
  exit: StrategyExit;
  risk: StrategyRisk;
  /** Free-form engine parameters (fees/slippage overrides land at P1.15). */
  params?: Record<string, string | number | boolean>;
}

export interface BacktestRequest {
  backtestId: string;
  strategyId: string;
  userId: string;
  spec: StrategySpec;
  fromTs: number;
  toTs: number;
  /** Fees/slippage model inputs; defaults defined by the engine at P1.15. */
  feesBps?: number;
  slippageBps?: number;
}

export interface BacktestMetrics {
  pnlPct: Dec;
  winRate: Dec;
  maxDrawdownPct: Dec;
  sharpe?: Dec;
  trades: number;
}
