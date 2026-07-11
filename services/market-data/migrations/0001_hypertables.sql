-- market-data 0001 — time-series hypertables (owner: svc_market_data, ADR-005).
-- All prices/quantities are NUMERIC (string-encoded decimals end to end, architecture.md §4.3).
-- All timestamps are timestamptz (UTC).

-- ── candles ──────────────────────────────────────────────────────────────────
-- One row per (exchange, symbol, timeframe, bucket). We ingest exchange-native
-- timeframes (1m,5m,15m,1h,4h,1d) rather than rolling up ourselves for MVP;
-- continuous aggregates are a later optimization (see /docs/schema.md §5).
CREATE TABLE candles (
  exchange     text        NOT NULL,
  symbol       text        NOT NULL, -- normalized lowercase, e.g. 'btcusdt'
  tf           text        NOT NULL CHECK (tf IN ('1m','5m','15m','1h','4h','1d')),
  ts           timestamptz NOT NULL, -- bucket open time
  open         numeric     NOT NULL,
  high         numeric     NOT NULL,
  low          numeric     NOT NULL,
  close        numeric     NOT NULL,
  volume       numeric     NOT NULL, -- base-asset volume
  quote_volume numeric,
  trade_count  integer,
  PRIMARY KEY (exchange, symbol, tf, ts)
);

SELECT create_hypertable('candles', 'ts', chunk_time_interval => INTERVAL '1 day');

ALTER TABLE candles SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'exchange, symbol, tf',
  timescaledb.compress_orderby   = 'ts'
);
SELECT add_compression_policy('candles', INTERVAL '7 days');
SELECT add_retention_policy('candles', INTERVAL '730 days');

-- ── open interest ────────────────────────────────────────────────────────────
CREATE TABLE oi (
  exchange         text        NOT NULL,
  symbol           text        NOT NULL,
  ts               timestamptz NOT NULL,
  open_interest    numeric     NOT NULL, -- contracts/base units
  open_interest_usd numeric,
  PRIMARY KEY (exchange, symbol, ts)
);

SELECT create_hypertable('oi', 'ts', chunk_time_interval => INTERVAL '1 day');
ALTER TABLE oi SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'exchange, symbol',
  timescaledb.compress_orderby   = 'ts'
);
SELECT add_compression_policy('oi', INTERVAL '7 days');
SELECT add_retention_policy('oi', INTERVAL '365 days');

-- ── funding rates ────────────────────────────────────────────────────────────
CREATE TABLE funding (
  exchange        text        NOT NULL,
  symbol          text        NOT NULL,
  ts              timestamptz NOT NULL, -- rate observation/settlement time
  rate            numeric     NOT NULL, -- e.g. 0.0001 = 1 bp
  next_funding_ts timestamptz,
  PRIMARY KEY (exchange, symbol, ts)
);

SELECT create_hypertable('funding', 'ts', chunk_time_interval => INTERVAL '7 days');
ALTER TABLE funding SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'exchange, symbol',
  timescaledb.compress_orderby   = 'ts'
);
SELECT add_compression_policy('funding', INTERVAL '30 days');
SELECT add_retention_policy('funding', INTERVAL '730 days');

-- ── liquidation events ───────────────────────────────────────────────────────
CREATE TABLE liq_events (
  exchange  text        NOT NULL,
  symbol    text        NOT NULL,
  ts        timestamptz NOT NULL,
  side      text        NOT NULL CHECK (side IN ('long','short')), -- position side liquidated
  price     numeric     NOT NULL,
  qty       numeric     NOT NULL,
  qty_usd   numeric,
  src       text        NOT NULL DEFAULT 'exchange' CHECK (src IN ('exchange','coinglass','hyperliquid')),
  -- no natural PK: multiple liqs can share (exchange,symbol,ts); dedupe key below
  event_id  text,       -- upstream id when the source provides one
  UNIQUE (exchange, symbol, ts, side, price, qty)
);

SELECT create_hypertable('liq_events', 'ts', chunk_time_interval => INTERVAL '1 day');
CREATE INDEX liq_events_sym_ts_idx ON liq_events (symbol, ts DESC);
ALTER TABLE liq_events SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'exchange, symbol',
  timescaledb.compress_orderby   = 'ts'
);
SELECT add_compression_policy('liq_events', INTERVAL '7 days');
SELECT add_retention_policy('liq_events', INTERVAL '365 days');

-- ── screener working set (latest state per instrument, not time-series) ─────
-- Deterministic snapshot the screener query engine reads (architecture.md §2).
-- Overwritten in place by market-data; small (thousands of rows).
CREATE TABLE instrument_state (
  exchange     text    NOT NULL,
  symbol       text    NOT NULL,
  asset_class  text    NOT NULL DEFAULT 'crypto' CHECK (asset_class IN ('crypto','stock')),
  price        numeric,
  change_1h    numeric, -- fraction, e.g. -0.052 = -5.2%
  change_24h   numeric,
  change_7d    numeric,
  volume_24h   numeric, -- quote (USD) volume
  market_cap   numeric,
  open_interest numeric,
  funding_rate numeric,
  volatility_24h numeric,
  spread       numeric,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exchange, symbol)
);

CREATE INDEX instrument_state_vol_idx ON instrument_state (volume_24h DESC NULLS LAST);

-- ── write grants (single-writer enforcement) ─────────────────────────────────
GRANT INSERT, UPDATE, DELETE ON candles, oi, funding, liq_events, instrument_state
  TO svc_market_data;
