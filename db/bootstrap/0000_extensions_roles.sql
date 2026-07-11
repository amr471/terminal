-- 0000_extensions_roles.sql — cluster bootstrap (run once per database, before any
-- service migration). Owner: repo root (not a service) — extensions and roles are
-- cluster-wide concerns.
--
-- ADR-005 (single-writer rule) is enforced HERE at the database level: every service
-- connects as its own role; only the owning role has write privileges on its tables.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS citext; -- case-insensitive emails

-- One login role per service. Passwords are set by the deployment environment
-- (ALTER ROLE ... PASSWORD via secret manager), never committed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_market_data') THEN
    CREATE ROLE svc_market_data LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_api_gateway') THEN
    CREATE ROLE svc_api_gateway LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_quant') THEN
    CREATE ROLE svc_quant LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_ai') THEN
    CREATE ROLE svc_ai LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_alert_engine') THEN
    CREATE ROLE svc_alert_engine LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'svc_telegram_bot') THEN
    CREATE ROLE svc_telegram_bot LOGIN;
  END IF;
END
$$;

-- Everyone may read everything (cross-service reads are allowed by ADR-005;
-- writes are not). Applies to tables created later by any migration.
GRANT USAGE ON SCHEMA public TO
  svc_market_data, svc_api_gateway, svc_quant, svc_ai, svc_alert_engine, svc_telegram_bot;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO
  svc_market_data, svc_api_gateway, svc_quant, svc_ai, svc_alert_engine, svc_telegram_bot;

-- Write grants are issued per-table by each owning service's migrations.
