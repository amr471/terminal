-- quant 0001 — backtest runs + results (owner: svc_quant, ADR-005).
-- Requested via evt.backtest_req, results announced via evt.backtest_done
-- (architecture.md §3). Deterministic runner: fees, slippage, lookahead handling (P1.15).

CREATE TABLE backtests (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id  uuid        NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued','running','done','failed','canceled')),
  params       jsonb       NOT NULL DEFAULT '{}'::jsonb, -- range, symbols, tf, fees, slippage
  spec_snapshot jsonb      NOT NULL, -- strategy spec frozen at request time (reproducibility)
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  error        text
);

CREATE INDEX backtests_user_idx ON backtests (user_id, requested_at DESC);
CREATE INDEX backtests_queue_idx ON backtests (requested_at) WHERE status = 'queued';

CREATE TABLE strategy_results (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  backtest_id  uuid        NOT NULL UNIQUE REFERENCES backtests(id) ON DELETE CASCADE,
  metrics      jsonb       NOT NULL, -- pnl, win_rate, max_drawdown, sharpe, trades, ...
  equity_curve jsonb,               -- downsampled [[ts, equity], ...] for charting
  trades       jsonb,               -- individual simulated fills (capped; full log to object storage later)
  created_at   timestamptz NOT NULL DEFAULT now()
);

GRANT INSERT, UPDATE, DELETE ON backtests, strategy_results TO svc_quant;
-- Note: the gateway does NOT insert request rows — it publishes evt.backtest_req;
-- quant creates the row when consuming the event. Single writer holds.
