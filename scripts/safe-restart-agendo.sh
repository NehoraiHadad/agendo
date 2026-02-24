#!/usr/bin/env bash
# safe-restart-agendo.sh
#
# Restarts the agendo Next.js app (PM2 name: "agendo") only after all active
# agent sessions have reached an idle/ended state.
#
# WHY THIS EXISTS
# ---------------
# The agendo MCP server is hosted inside the Next.js process on port 4100.
# Running `pm2 restart agendo` kills that process, which immediately drops any
# in-flight MCP connections — ending any agent session that is currently running.
#
# This script polls /api/sessions and waits until no session is in an active
# state before issuing the restart. Use it whenever agendo itself (not the
# worker) needs to be restarted during a live agent session.
#
# USAGE
# -----
#   ./scripts/safe-restart-agendo.sh              # defaults
#   ./scripts/safe-restart-agendo.sh --force      # restart immediately (skip wait)
#   AGENDO_PORT=4200 ./scripts/safe-restart-agendo.sh
#
# ENVIRONMENT
#   AGENDO_PORT    (default: 4100)
#   MAX_WAIT_SEC   (default: 300 = 5 minutes)
#   POLL_SEC       (default: 5)

set -euo pipefail

AGENDO_PORT="${AGENDO_PORT:-4100}"
MAX_WAIT_SEC="${MAX_WAIT_SEC:-300}"
POLL_SEC="${POLL_SEC:-5}"
FORCE="${1:-}"

BASE_URL="http://localhost:${AGENDO_PORT}"
ACTIVE_STATUSES='["active","awaiting_input","running"]'

# Colours (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m' YELLOW='\033[1;33m' GREEN='\033[0;32m' NC='\033[0m'
else
  RED='' YELLOW='' GREEN='' NC=''
fi

log()  { echo -e "${NC}[safe-restart] $*${NC}"; }
warn() { echo -e "${YELLOW}[safe-restart] $*${NC}"; }
ok()   { echo -e "${GREEN}[safe-restart] $*${NC}"; }
err()  { echo -e "${RED}[safe-restart] $*${NC}" >&2; }

# ── Helpers ──────────────────────────────────────────────────────────────────

active_session_count() {
  local response
  response=$(curl -sf --max-time 5 "${BASE_URL}/api/sessions?pageSize=100" 2>/dev/null) || {
    warn "Could not reach ${BASE_URL}/api/sessions — assuming 0 active sessions"
    echo 0
    return
  }
  # Count sessions whose status is in the active-statuses list
  echo "$response" \
    | jq --argjson active "${ACTIVE_STATUSES}" \
      '[.data[] | select(.status as $s | $active | index($s) != null)] | length' \
      2>/dev/null \
    || echo 0
}

do_restart() {
  log "Restarting agendo..."
  pm2 restart agendo --update-env
  pm2 save --force >/dev/null 2>&1 || true
  ok "agendo restarted successfully."
}

# ── Main ─────────────────────────────────────────────────────────────────────

if [[ "$FORCE" == "--force" ]]; then
  warn "--force flag set, skipping session check."
  do_restart
  exit 0
fi

# Quick check: are jq and curl available?
for cmd in curl jq pm2; do
  if ! command -v "$cmd" &>/dev/null; then
    err "Required command '$cmd' not found. Aborting."
    exit 1
  fi
done

log "Checking for active agent sessions on ${BASE_URL}..."
START=$(date +%s)

while true; do
  ACTIVE=$(active_session_count)

  if [ "$ACTIVE" -eq 0 ]; then
    ok "No active sessions found."
    do_restart
    exit 0
  fi

  NOW=$(date +%s)
  ELAPSED=$(( NOW - START ))
  REMAINING=$(( MAX_WAIT_SEC - ELAPSED ))

  if [ "$ELAPSED" -ge "$MAX_WAIT_SEC" ]; then
    warn "Timeout after ${MAX_WAIT_SEC}s — ${ACTIVE} session(s) still active."
    warn "Forcing restart (sessions will be auto-resumed by the stale-reaper)."
    do_restart
    exit 0
  fi

  log "${ACTIVE} active session(s) running. Waiting... (${ELAPSED}s / ${MAX_WAIT_SEC}s)"
  sleep "$POLL_SEC"
done
