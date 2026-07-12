-- db/dev/set-passwords.sql — LOCAL DEV ONLY.
--
-- db/bootstrap/0000_extensions_roles.sql creates the six svc_* login roles with no
-- password (ADR-005: passwords are set by the deployment environment / secret
-- manager, never committed — see the trading-security skill). Local dev has no
-- secret manager, so this script assigns one shared password to all six roles
-- from LOCAL_DEV_DB_PASSWORD so each service's own DATABASE_URL can connect.
--
-- NEVER run this against staging or production. NEVER commit a real value for
-- LOCAL_DEV_DB_PASSWORD — the default in .env.example is a placeholder meant
-- only for a throwaway local Postgres container.
--
-- Usage (see scripts/dev-env.sh):
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v pass="'$LOCAL_DEV_DB_PASSWORD'" \
--     -f db/dev/set-passwords.sql

ALTER ROLE svc_market_data  PASSWORD :pass;
ALTER ROLE svc_api_gateway  PASSWORD :pass;
ALTER ROLE svc_quant        PASSWORD :pass;
ALTER ROLE svc_ai           PASSWORD :pass;
ALTER ROLE svc_alert_engine PASSWORD :pass;
ALTER ROLE svc_telegram_bot PASSWORD :pass;
