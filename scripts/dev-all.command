#!/usr/bin/env bash
# macOS launcher: opens three Terminal windows, one per dev process.
#
# Double-click this file in Finder, or run `pnpm dev:all` from the repo root.
# Each process gets its own window so their logs stay readable and any one of
# them can be Ctrl-C'd without killing the others (market-data in particular
# is very chatty).
#
# Requires the infra to be up first: `pnpm dev:up && pnpm dev:migrate`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# osascript can't take a bare `cd x && y` reliably through quoting layers, so
# each command is written as a single shell string and escaped once here.
open_window() {
  local title="$1" cmd="$2"
  # Escape backslashes and double quotes for the AppleScript string literal.
  local escaped="${cmd//\\/\\\\}"
  escaped="${escaped//\"/\\\"}"
  osascript <<EOF
tell application "Terminal"
  activate
  do script "cd '${REPO_ROOT}' && echo '=== ${title} ===' && ${escaped}"
end tell
EOF
}

open_window "market-data (Go)" "cd services/market-data && go run ./cmd/market-data"
open_window "api-gateway" "pnpm dev:gateway"
open_window "web" "pnpm dev:web"

echo "Launched 3 Terminal windows: market-data, api-gateway, web."
echo "If the terminal is empty, run 'pnpm dev:up && pnpm dev:migrate' first."
