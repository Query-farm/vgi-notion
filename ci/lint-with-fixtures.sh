#!/usr/bin/env bash
# Run vgi-lint with a `notion` secret pointing at the offline replay server, so the
# execution rules (VGI9xx: examples bind and run, result schemas match DESCRIBE, agent
# tasks) exercise the worker against fixtures instead of a live workspace.
#
#   ci/lint-with-fixtures.sh <vgi-lint lint command…> <worker> [lint args…]
#
# query_data_source / query_database read the data source schema when they are bound,
# so even EXPLAIN of their examples needs a secret. The secret type exists only once
# the worker is attached, so the setup SQL attaches it under a throwaway alias first.
# CI's metadata job runs with execute: "false" (no live Notion credentials) and does
# not use this script.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PYTHON="${PYTHON:-python3}"
WORKER="$REPO/bin/vgi-notion-worker"

LOG="$(mktemp)"
$PYTHON "$REPO/test/mock_api/server.py" >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; rm -f "$LOG"' EXIT
PORT=""
for _ in $(seq 1 60); do
  PORT="$(sed -n 's/^PORT:\([0-9][0-9]*\).*/\1/p' "$LOG" | head -1)"
  [ -n "$PORT" ] && break
  kill -0 "$PID" 2>/dev/null || { cat "$LOG"; exit 1; }
  sleep 0.25
done
[ -n "$PORT" ] || { echo "replay server did not start"; cat "$LOG"; exit 1; }

"$@" \
  --setup-sql "ATTACH 'notion' AS notion_lint_setup (TYPE vgi, LOCATION '$WORKER')" \
  --setup-sql "CREATE SECRET notion_fixture (TYPE notion, TOKEN 'ntn_test_token', BASE_URL 'http://127.0.0.1:$PORT', REQUESTS_PER_SECOND '50')" \
  --setup-sql "DETACH notion_lint_setup"
