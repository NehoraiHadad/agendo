#!/usr/bin/env bash
# demo-post-deploy-smoke.sh — Post-deploy smoke test for agendo demo mode.
#
# Usage:
#   BASE_URL=https://agendo-demo.vercel.app ./scripts/demo-post-deploy-smoke.sh
#
# If BASE_URL is not set, defaults to http://localhost:4100.
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:4100}"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
GREEN='\033[0;32m'
RED='\033[0;31m'
RESET='\033[0m'

pass=0
fail=0

pass_msg()  { echo -e "  ${GREEN}PASS${RESET}  $1"; pass=$((pass + 1)); }
fail_msg()  { echo -e "  ${RED}FAIL${RESET}  $1"; fail=$((fail + 1)); }

# ---------------------------------------------------------------------------
# check_http <label> <url>
#   Asserts HTTP 200 via curl --fail. Non-2xx → counts as FAIL (no exit).
# ---------------------------------------------------------------------------
check_http() {
  local label="$1"
  local url="$2"
  local http_code
  http_code=$(curl --silent --output /dev/null --write-out "%{http_code}" \
    --max-time 15 "$url" 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    pass_msg "$label ($http_code)"
  else
    fail_msg "$label — expected 200, got $http_code — $url"
  fi
}

# ---------------------------------------------------------------------------
# check_sse <label> <url>
#   Asserts that the endpoint returns a text/event-stream content-type and
#   at least one SSE frame within --max-time seconds.
# ---------------------------------------------------------------------------
check_sse() {
  local label="$1"
  local url="$2"
  local headers
  headers=$(curl --silent --head --max-time 5 \
    --header "Accept: text/event-stream" "$url" 2>/dev/null || true)
  local content_type
  content_type=$(echo "$headers" | grep -i "content-type" | head -1 || true)
  if echo "$content_type" | grep -qi "text/event-stream"; then
    pass_msg "$label (SSE Content-Type confirmed)"
  else
    # Fall back to reading a few bytes — some servers don't respond to HEAD
    local body
    body=$(curl --silent --max-time 3 --no-buffer \
      --header "Accept: text/event-stream" "$url" 2>/dev/null || true)
    if echo "$body" | grep -q "^data:" || echo "$body" | grep -q "^event:" || echo "$body" | grep -q "^id:"; then
      pass_msg "$label (SSE frames received)"
    else
      fail_msg "$label — no SSE content-type or frames — $url"
    fi
  fi
}

# ---------------------------------------------------------------------------
# check_json <label> <url>
#   Asserts HTTP 200 and that the response body is valid JSON.
# ---------------------------------------------------------------------------
check_json() {
  local label="$1"
  local url="$2"
  local body
  local http_code
  http_code=$(curl --silent --output /tmp/_agendo_smoke_body.json \
    --write-out "%{http_code}" --max-time 15 "$url" 2>/dev/null || echo "000")
  body=$(cat /tmp/_agendo_smoke_body.json 2>/dev/null || echo "")
  rm -f /tmp/_agendo_smoke_body.json
  if [[ "$http_code" == "200" ]] && echo "$body" | python3 -m json.tool > /dev/null 2>&1; then
    pass_msg "$label (JSON 200)"
  elif [[ "$http_code" == "200" ]] && command -v jq > /dev/null 2>&1 && echo "$body" | jq . > /dev/null 2>&1; then
    pass_msg "$label (JSON 200)"
  else
    fail_msg "$label — expected JSON 200, got $http_code — $url"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

echo ""
echo "Demo post-deploy smoke: ${BASE_URL}"
echo "────────────────────────────────────────────────────────"
echo ""
echo "  Pages"

check_http "GET /"                   "${BASE_URL}/"
check_http "GET /tasks"              "${BASE_URL}/tasks"
check_http "GET /sessions"           "${BASE_URL}/sessions"
check_http "GET /sessions (claude)"  "${BASE_URL}/sessions/77777777-7777-4777-a777-777777777777"
check_http "GET /sessions (codex)"   "${BASE_URL}/sessions/88888888-8888-4888-a888-888888888888"
check_http "GET /sessions (gemini)"  "${BASE_URL}/sessions/99999999-9999-4999-a999-999999999999"
check_http "GET /projects"           "${BASE_URL}/projects"
check_http "GET /projects (agendo)"  "${BASE_URL}/projects/44444444-4444-4444-a444-444444444444"
check_http "GET /plans"              "${BASE_URL}/plans"
check_http "GET /plans (demo)"       "${BASE_URL}/plans/cccccccc-cccc-4001-c001-cccccccccccc"
check_http "GET /brainstorms (demo)" "${BASE_URL}/brainstorms/eeeeeeee-eeee-4001-e001-eeeeeeeeeeee"
check_http "GET /agents (claude)"    "${BASE_URL}/agents/11111111-1111-4111-a111-111111111111"
check_http "GET /workspace (demo)"   "${BASE_URL}/workspace/bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb"
check_http "GET /settings"           "${BASE_URL}/settings"
check_http "GET /integrations"       "${BASE_URL}/integrations"

echo ""
echo "  API routes"

check_json "GET /api/sessions/77.../history (JSON)" \
  "${BASE_URL}/api/sessions/77777777-7777-4777-a777-777777777777/history"

check_sse "GET /api/sse/board (SSE)" \
  "${BASE_URL}/api/sse/board"

check_sse "GET /api/sessions/77.../events (SSE)" \
  "${BASE_URL}/api/sessions/77777777-7777-4777-a777-777777777777/events"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "────────────────────────────────────────────────────────"
total=$((pass + fail))
if [[ "$fail" -eq 0 ]]; then
  echo -e "${GREEN}${pass} passed, 0 failed${RESET} (${total} total)"
  exit 0
else
  echo -e "${pass} passed, ${RED}${fail} failed${RESET} (${total} total)"
  exit 1
fi
