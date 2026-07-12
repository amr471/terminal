-- db/dev/seed.sql — local dev seed data. Idempotent (safe to re-run); dev tooling
-- only, not a service migration, so it is not listed in db/migrate.sh.
--
-- Runs as the Postgres superuser (see scripts/dev-env.sh), which bypasses the
-- ADR-005 single-writer grants — acceptable for seeding fixtures locally, but
-- never do this in a real service's runtime path.
--
-- Usage: psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/dev/seed.sql

INSERT INTO instrument_state
  (exchange, symbol, asset_class, price, change_1h, change_24h, change_7d,
   volume_24h, market_cap, open_interest, funding_rate, volatility_24h, spread)
VALUES
  ('binance', 'btcusdt', 'crypto', 67000.50,  0.0021, -0.0140,  0.0320,
   2100000000, 1320000000000, 850000000,  0.00010, 0.021, 0.5),
  ('binance', 'ethusdt', 'crypto',  3450.10, -0.0035, -0.0280,  0.0100,
    980000000,  415000000000, 320000000, -0.00005, 0.028, 0.6),
  ('bybit',   'solusdt', 'crypto',   168.75,  0.0120,  0.0410,  0.0950,
    410000000,   78000000000,  95000000,  0.00020, 0.045, 1.2),
  ('binance', 'aapl',    'stock',    225.30,  0.0008,  0.0052, -0.0110,
     52000000,             NULL,      NULL,      NULL, 0.014, 0.1)
ON CONFLICT (exchange, symbol) DO UPDATE SET
  asset_class    = EXCLUDED.asset_class,
  price          = EXCLUDED.price,
  change_1h      = EXCLUDED.change_1h,
  change_24h     = EXCLUDED.change_24h,
  change_7d      = EXCLUDED.change_7d,
  volume_24h     = EXCLUDED.volume_24h,
  market_cap     = EXCLUDED.market_cap,
  open_interest  = EXCLUDED.open_interest,
  funding_rate   = EXCLUDED.funding_rate,
  volatility_24h = EXCLUDED.volatility_24h,
  spread         = EXCLUDED.spread,
  updated_at     = now();
