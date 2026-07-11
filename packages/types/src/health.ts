/**
 * Health & degradation contract (architecture.md §5.5): every service reports
 * this shape via `health:{service}` in Redis and GET /healthz | /readyz.
 */

export const HEALTH_STATES = ['LIVE', 'DEGRADED', 'STALE', 'DOWN'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export interface HealthReport {
  status: HealthState;
  /** Per-feed states, e.g. { 'binance.ws': 'LIVE', 'coinglass.rest': 'DEGRADED' }. */
  feeds: Record<string, HealthState>;
  /** p95 of rts - ts over the report window, ms. */
  lagMsP95?: number;
  updatedAt: number; // ms epoch
}

/** Worst-of aggregation used by the gateway when rolling services up for the UI. */
export function worstState(states: HealthState[]): HealthState {
  const order: readonly HealthState[] = ['LIVE', 'DEGRADED', 'STALE', 'DOWN'];
  return states.reduce<HealthState>(
    (worst, s) => (order.indexOf(s) > order.indexOf(worst) ? s : worst),
    'LIVE',
  );
}
