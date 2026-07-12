#!/usr/bin/env bash
# scripts/dev-env.sh — local dev environment orchestrator (P1.0).
#
# Wraps docker compose + db/migrate.sh + local svc_* role passwords + seed data
# so a fresh clone can go from `git clone` to a working local stack in a few
# commands. Prerequisites: Docker, a `psql` client on PATH.
#
# Usage:
#   ./scripts/dev-env.sh up       # start Postgres+Timescale & Redis, wait until healthy
#   ./scripts/dev-env.sh migrate  # run db/migrate.sh, then set local svc_* role passwords
#   ./scripts/dev-env.sh seed     # load db/dev/seed.sql
#   ./scripts/dev-env.sh reset    # down -v && up && migrate && seed (wipes all local data)
#   ./scripts/dev-env.sh down     # stop containers (volumes kept)

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Load .env if present — docker compose auto-loads it for the containers, but this
# script also needs the same values to build the admin DATABASE_URL below.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

POSTGRES_DB="${POSTGRES_DB:-terminal}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
LOCAL_DEV_DB_PASSWORD="${LOCAL_DEV_DB_PASSWORD:-dev_local_only}"

# Superuser connection, used only by this script (migrations, role passwords, seed).
# Services connect with their own svc_* DATABASE_URL — see .env.example.
ADMIN_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}"

wait_for_db() {
  echo "waiting for Postgres..."
  for _ in $(seq 1 30); do
    if docker compose exec -T db pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
      echo "Postgres is ready."
      return 0
    fi
    sleep 1
  done
  echo "Postgres did not become ready in time" >&2
  exit 1
}

cmd="${1:-}"
case "$cmd" in
  up)
    docker compose up -d
    wait_for_db
    ;;
  migrate)
    DATABASE_URL="$ADMIN_DATABASE_URL" "$ROOT/db/migrate.sh"
    psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
      -v pass="'$LOCAL_DEV_DB_PASSWORD'" \
      -f "$ROOT/db/dev/set-passwords.sql"
    echo "svc_* role passwords set for local dev (LOCAL_DEV_DB_PASSWORD)."
    ;;
  seed)
    psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/db/dev/seed.sql"
    echo "seed data loaded."
    ;;
  reset)
    docker compose down -v
    "$0" up
    "$0" migrate
    "$0" seed
    ;;
  down)
    docker compose down
    ;;
  *)
    echo "usage: $0 {up|migrate|seed|reset|down}" >&2
    exit 1
    ;;
esac
