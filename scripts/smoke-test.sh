#!/usr/bin/env bash
# Post-setup smoke test for Agendo.
# Usage: ./scripts/smoke-test.sh [base_url]
# Default base_url: http://localhost:4100
set -euo pipefail

BASE_URL="${1:-http://localhost:4100}"
PASS=0
FAIL=0
WARNINGS=0

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

pass() { PASS=$((PASS + 1)); echo -e "${GREEN}  PASS${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "${RED}  FAIL${NC} $1"; }
warn() { WARNINGS=$((WARNINGS + 1)); echo -e "${YELLOW}  WARN${NC} $1"; }

echo ""
echo "=== Agendo Smoke Test ==="
echo "Target: $BASE_URL"
echo ""

# -----------------------------------------------------------------------
# 1. Health endpoint (basic)
# -----------------------------------------------------------------------
echo "--- Core Health ---"

HEALTH=$(curl -sf "$BASE_URL/api/health" 2>/dev/null) || {
  fail "GET /api/health unreachable"
  echo -e "\n${RED}Cannot reach Agendo. Is it running?${NC}"
  exit 1
}

STATUS=$(echo "$HEALTH" | jq -r '.status')
if [ "$STATUS" = "ok" ]; then
  pass "Health status: ok"
elif [ "$STATUS" = "degraded" ]; then
  warn "Health status: degraded"
else
  fail "Health status: $STATUS"
fi

# -----------------------------------------------------------------------
# 2. Detailed health
# -----------------------------------------------------------------------
echo ""
echo "--- Detailed Health ---"

DETAILED=$(curl -sf "$BASE_URL/api/health?detailed=true" 2>/dev/null | jq '.') || {
  fail "GET /api/health?detailed=true unreachable"
  DETAILED=""
}

if [ -n "$DETAILED" ]; then
  DB_STATUS=$(echo "$DETAILED" | jq -r '.checks.database.status')
  if [ "$DB_STATUS" = "ok" ]; then
    pass "Database: connected"
  else
    fail "Database: $DB_STATUS"
  fi

  DB_LATENCY=$(echo "$DETAILED" | jq -r '.checks.database.latencyMs // 0')
  if [ "$DB_LATENCY" -lt 100 ] 2>/dev/null; then
    pass "DB latency: ${DB_LATENCY}ms"
  else
    warn "DB latency high: ${DB_LATENCY}ms"
  fi

  WORKER_STATUS=$(echo "$DETAILED" | jq -r '.checks.worker.status')
  if [ "$WORKER_STATUS" = "ok" ]; then
    pass "Worker: running"
  else
    fail "Worker: $WORKER_STATUS"
  fi

  AGENT_COUNT=$(echo "$DETAILED" | jq -r '.checks.agents.count // 0')
  if [ "$AGENT_COUNT" -gt 0 ] 2>/dev/null; then
    pass "Agents discovered: $AGENT_COUNT"
  else
    fail "No agents discovered"
  fi

  MCP_EXISTS=$(echo "$DETAILED" | jq -r '.checks.mcp.exists')
  if [ "$MCP_EXISTS" = "true" ]; then
    pass "MCP server bundle: exists"
  else
    warn "MCP server bundle: missing (run pnpm build:mcp)"
  fi

  DISK_STATUS=$(echo "$DETAILED" | jq -r '.checks.disk.status')
  DISK_FREE=$(echo "$DETAILED" | jq -r '.checks.disk.freeGB // 0')
  if [ "$DISK_STATUS" = "ok" ]; then
    pass "Disk space: ${DISK_FREE}GB free"
  else
    warn "Disk space low: ${DISK_FREE}GB"
  fi
fi

# -----------------------------------------------------------------------
# 3. API routes reachable
# -----------------------------------------------------------------------
echo ""
echo "--- API Routes ---"

check_api() {
  local method="$1" url="$2" label="$3" expected_status="${4:-200}"
  local http_code
  http_code=$(curl -sf -o /dev/null -w '%{http_code}' -X "$method" "$BASE_URL$url" 2>/dev/null) || http_code="000"
  if [ "$http_code" = "$expected_status" ]; then
    pass "$label (HTTP $http_code)"
  else
    fail "$label (expected $expected_status, got $http_code)"
  fi
}

check_api GET "/api/projects" "List projects"
check_api GET "/api/agents" "List agents"
check_api GET "/api/tasks" "List tasks"
check_api GET "/api/dashboard" "Dashboard stats"
check_api GET "/api/workers/status" "Worker status"

# -----------------------------------------------------------------------
# 4. Agent binary checks
# -----------------------------------------------------------------------
echo ""
echo "--- Agent Binaries ---"

for bin in claude codex gemini; do
  if command -v "$bin" >/dev/null 2>&1; then
    version=$("$bin" --version 2>&1 | head -1 || echo "unknown")
    pass "$bin found: $version"
  else
    warn "$bin not on PATH (sessions using this agent will fail)"
  fi
done

# -----------------------------------------------------------------------
# 5. Write test (create task + delete)
# -----------------------------------------------------------------------
echo ""
echo "--- Write Test (create task + delete) ---"

TASK_RESP=$(curl -sf -X POST "$BASE_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{"title":"[smoke-test] health check","description":"Auto-created by smoke test. Safe to delete.","priority":1}' \
  2>/dev/null) || TASK_RESP=""

if [ -n "$TASK_RESP" ]; then
  TASK_ID=$(echo "$TASK_RESP" | jq -r '.data.id // .id // empty')
  if [ -n "$TASK_ID" ]; then
    pass "Create task: $TASK_ID"
    # Clean up
    DEL_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X DELETE "$BASE_URL/api/tasks/$TASK_ID" 2>/dev/null) || DEL_CODE="000"
    if [ "$DEL_CODE" = "200" ] || [ "$DEL_CODE" = "204" ]; then
      pass "Delete task: cleaned up"
    else
      warn "Delete task: HTTP $DEL_CODE (manual cleanup needed)"
    fi
  else
    fail "Create task: bad response"
  fi
else
  warn "Create task: skipped (API may require auth)"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "=== Results ==="
echo -e "  ${GREEN}Passed:${NC}   $PASS"
echo -e "  ${RED}Failed:${NC}   $FAIL"
echo -e "  ${YELLOW}Warnings:${NC} $WARNINGS"
echo ""

if [ $FAIL -gt 0 ]; then
  echo -e "${RED}Smoke test FAILED${NC}"
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}Smoke test PASSED with warnings${NC}"
  exit 0
else
  echo -e "${GREEN}Smoke test PASSED${NC}"
  exit 0
fi
