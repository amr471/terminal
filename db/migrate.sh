#!/usr/bin/env bash
# db/migrate.sh — apply all migrations in dependency order (ADR-005: migrations live
# with their owning service; this script only sequences them).
#
# Usage: DATABASE_URL=postgres://user:pass@host:5432/terminal ./db/migrate.sh
# Idempotence: applied files are recorded in schema_migrations; already-applied
# files are skipped. Files are applied in the exact order listed below.

set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL, e.g. postgres://localhost:5432/terminal}"
PSQL="${PSQL:-psql}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Dependency order: bootstrap (extensions+roles) → users (everything FKs to users)
# → market data → alerts → ai (strategies) → quant (FKs to strategies) → telegram.
MIGRATIONS=(
  "db/bootstrap/0000_extensions_roles.sql"
  "services/api-gateway/migrations/0001_users_auth.sql"
  "services/api-gateway/migrations/0002_screens_layouts_journal.sql"
  "services/api-gateway/migrations/0003_users_email_nullable.sql"
  "services/api-gateway/migrations/0004_layout_tabs.sql"
  "services/market-data/migrations/0001_hypertables.sql"
  "services/alert-engine/migrations/0001_alerts.sql"
  "services/ai/migrations/0001_strategies.sql"
  "services/quant/migrations/0001_backtests.sql"
  "services/telegram-bot/migrations/0001_tg_links.sql"
)

$PSQL "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "CREATE TABLE IF NOT EXISTS schema_migrations (
     filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"

for m in "${MIGRATIONS[@]}"; do
  applied=$($PSQL "$DATABASE_URL" -tA -c \
    "SELECT 1 FROM schema_migrations WHERE filename = '$m'")
  if [[ "$applied" == "1" ]]; then
    echo "skip   $m"
    continue
  fi
  echo "apply  $m"
  # NOTE: -1 (single transaction) is intentionally NOT used: TimescaleDB policy
  # functions (add_compression_policy etc.) cannot run inside a transaction block
  # in some versions. Each file must therefore be self-consistent.
  $PSQL "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/$m"
  $PSQL "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
    "INSERT INTO schema_migrations (filename) VALUES ('$m');"
done

echo "done — $(${PSQL} "$DATABASE_URL" -tA -c 'SELECT count(*) FROM schema_migrations') migration(s) recorded"
