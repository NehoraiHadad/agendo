# Health Check & Smoke Test Analysis

## Current State

Agendo already has a basic health endpoint at `GET /api/health` (`src/app/api/health/route.ts`) that checks:

- **DB connectivity** — queries `agents` and `workerHeartbeats` tables in parallel
- **Worker liveness** — heartbeat freshness (< 60s = `running`, else `stale`)
- **Agent discovery** — lists active agent names
- **Version** — from `npm_package_version`

Returns `200` for `ok`/`degraded`, `503` for `error`. Response shape:

```json
{
  "status": "ok" | "degraded" | "error",
  "db": "connected" | "error",
  "worker": "running" | "stale" | "unknown",
  "agents": ["Claude Code", "Codex CLI", "Gemini CLI"],
  "version": "0.1.0"
}
```

**Additional existing endpoints:**

- `GET /api/workers/status` — raw worker heartbeat rows
- `GET /api/system-stats` — proxies to server-monitor API (CPU, mem, disk, processes)
- `GET /api/dashboard` — task/session statistics

**What's missing:**

- No MCP server status check
- No disk space check (worker checks on startup but health endpoint doesn't)
- No pg-boss queue health check
- No agent binary verification (are the CLIs actually on PATH?)
- `setup.sh` ends with "Setup complete!" but never verifies anything works
- No CI smoke test

---

## 1. Enhanced `GET /api/health` — Recommended Schema

Keep the existing endpoint fast for load balancer probes. Add an optional `?detailed=true` query param for the full picture.

### Basic response (< 100ms, for uptime monitors / load balancers)

```json
{
  "status": "ok" | "degraded" | "error",
  "version": "0.1.0",
  "uptime": 3600
}
```

HTTP status: `200` for ok/degraded, `503` for error.

### Detailed response (`?detailed=true`, < 500ms, for dashboards / debugging)

```json
{
  "status": "ok" | "degraded" | "error",
  "version": "0.1.0",
  "uptime": 3600,
  "checks": {
    "database": {
      "status": "ok" | "error",
      "latencyMs": 12
    },
    "worker": {
      "status": "ok" | "stale" | "unknown",
      "lastSeenAt": "2026-03-06T12:00:00Z",
      "workerId": "worker-1"
    },
    "agents": {
      "discovered": ["Claude Code", "Codex CLI", "Gemini CLI"],
      "count": 3
    },
    "queue": {
      "status": "ok" | "error",
      "activeJobs": 1,
      "queuedJobs": 0
    },
    "disk": {
      "status": "ok" | "low",
      "freeGB": 22.5,
      "logDir": "/data/agendo/logs"
    },
    "mcp": {
      "serverPath": "/home/ubuntu/projects/agendo/dist/mcp-server.js",
      "exists": true
    }
  }
}
```

### Implementation sketch

```typescript
// src/app/api/health/route.ts
import { db } from '@/lib/db';
import { agents, workerHeartbeats } from '@/lib/db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config } from '@/lib/config';

export const dynamic = 'force-dynamic';

const startTime = Date.now();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const detailed = url.searchParams.get('detailed') === 'true';

  const status: HealthResponse = {
    status: 'ok',
    version: process.env.npm_package_version ?? '0.1.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };

  if (!detailed) {
    // Quick DB ping only
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      status.status = 'error';
      return Response.json(status, { status: 503 });
    }
    return Response.json(status);
  }

  // Detailed: run all checks in parallel
  const checks: DetailedChecks = {};
  const dbStart = Date.now();

  try {
    const [agentRows, heartbeatRows, queueStats] = await Promise.all([
      db.select({ name: agents.name }).from(agents).where(eq(agents.isActive, true)),
      db
        .select({ workerId: workerHeartbeats.workerId, lastSeenAt: workerHeartbeats.lastSeenAt })
        .from(workerHeartbeats)
        .orderBy(desc(workerHeartbeats.lastSeenAt))
        .limit(1),
      db.execute(sql`
        SELECT state, count(*)::int as count
        FROM pgboss.job
        WHERE name IN ('run-session', 'execute-capability')
          AND state IN ('active', 'created')
        GROUP BY state
      `),
    ]);

    checks.database = { status: 'ok', latencyMs: Date.now() - dbStart };
    checks.agents = {
      discovered: agentRows.map((a) => a.name),
      count: agentRows.length,
    };

    // Worker heartbeat
    if (heartbeatRows.length > 0) {
      const hb = heartbeatRows[0];
      const ageMs = Date.now() - hb.lastSeenAt.getTime();
      checks.worker = {
        status: ageMs < 60_000 ? 'ok' : 'stale',
        lastSeenAt: hb.lastSeenAt.toISOString(),
        workerId: hb.workerId,
      };
    } else {
      checks.worker = { status: 'unknown', lastSeenAt: null, workerId: null };
    }

    // Queue stats
    const active = queueStats.rows?.find((r) => r.state === 'active');
    const queued = queueStats.rows?.find((r) => r.state === 'created');
    checks.queue = {
      status: 'ok',
      activeJobs: active?.count ?? 0,
      queuedJobs: queued?.count ?? 0,
    };
  } catch {
    checks.database = { status: 'error', latencyMs: Date.now() - dbStart };
    status.status = 'error';
  }

  // Disk check (non-blocking — don't fail health for this)
  try {
    const stats = await statfs(config.LOG_DIR);
    const freeGB = (stats.bavail * stats.bsize) / 1024 ** 3;
    checks.disk = {
      status: freeGB >= 5 ? 'ok' : 'low',
      freeGB: Math.round(freeGB * 10) / 10,
      logDir: config.LOG_DIR,
    };
  } catch {
    checks.disk = { status: 'error', freeGB: 0, logDir: config.LOG_DIR };
  }

  // MCP server file existence
  const mcpPath = config.MCP_SERVER_PATH;
  checks.mcp = {
    serverPath: mcpPath ?? null,
    exists: mcpPath ? existsSync(mcpPath) : false,
  };

  // Derive top-level status
  if (checks.database?.status === 'error') status.status = 'error';
  else if (checks.worker?.status !== 'ok' || checks.disk?.status === 'low')
    status.status = 'degraded';

  const httpStatus = status.status === 'error' ? 503 : 200;
  return Response.json({ ...status, checks }, { status: httpStatus });
}
```

### Design decisions

| Decision                   | Rationale                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `?detailed=true` split     | Basic probe stays < 100ms (single `SELECT 1`). Detailed mode does 3 parallel queries + disk stat — still < 500ms                      |
| No auth on health          | Standard practice. Health endpoints are public. Sensitive data (paths) only in detailed mode — lock behind auth if exposed externally |
| pg-boss query              | Direct `pgboss.job` table query instead of boss API — avoids initializing a pg-boss instance in the Next.js process                   |
| Disk check in health       | Worker checks on startup, but disk can fill during runtime. Health should surface it                                                  |
| MCP `exists` not `working` | Can't test MCP without spawning a process. File existence is the cheap check; smoke test covers the rest                              |

---

## 2. Smoke Test Script

A post-setup verification script that confirms all components work end-to-end.

### `scripts/smoke-test.sh`

```bash
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

pass() { ((PASS++)); echo -e "${GREEN}  PASS${NC} $1"; }
fail() { ((FAIL++)); echo -e "${RED}  FAIL${NC} $1"; }
warn() { ((WARNINGS++)); echo -e "${YELLOW}  WARN${NC} $1"; }

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
if [[ "$STATUS" == "ok" ]]; then
  pass "Health status: ok"
elif [[ "$STATUS" == "degraded" ]]; then
  warn "Health status: degraded"
else
  fail "Health status: $STATUS"
fi

# -----------------------------------------------------------------------
# 2. Detailed health
# -----------------------------------------------------------------------
DETAILED=$(curl -sf "$BASE_URL/api/health?detailed=true" | jq '.')

DB_STATUS=$(echo "$DETAILED" | jq -r '.checks.database.status')
[[ "$DB_STATUS" == "ok" ]] && pass "Database: connected" || fail "Database: $DB_STATUS"

DB_LATENCY=$(echo "$DETAILED" | jq -r '.checks.database.latencyMs')
if [[ "$DB_LATENCY" -lt 100 ]]; then
  pass "DB latency: ${DB_LATENCY}ms"
else
  warn "DB latency high: ${DB_LATENCY}ms"
fi

WORKER_STATUS=$(echo "$DETAILED" | jq -r '.checks.worker.status')
[[ "$WORKER_STATUS" == "ok" ]] && pass "Worker: running" || fail "Worker: $WORKER_STATUS"

AGENT_COUNT=$(echo "$DETAILED" | jq -r '.checks.agents.count')
[[ "$AGENT_COUNT" -gt 0 ]] && pass "Agents discovered: $AGENT_COUNT" || fail "No agents discovered"

MCP_EXISTS=$(echo "$DETAILED" | jq -r '.checks.mcp.exists')
[[ "$MCP_EXISTS" == "true" ]] && pass "MCP server bundle: exists" || warn "MCP server bundle: missing (run pnpm build:mcp)"

DISK_STATUS=$(echo "$DETAILED" | jq -r '.checks.disk.status')
DISK_FREE=$(echo "$DETAILED" | jq -r '.checks.disk.freeGB')
[[ "$DISK_STATUS" == "ok" ]] && pass "Disk space: ${DISK_FREE}GB free" || warn "Disk space low: ${DISK_FREE}GB"

# -----------------------------------------------------------------------
# 3. API routes reachable
# -----------------------------------------------------------------------
echo ""
echo "--- API Routes ---"

check_api() {
  local method="$1" url="$2" label="$3" expected_status="${4:-200}"
  local http_code
  http_code=$(curl -sf -o /dev/null -w '%{http_code}' -X "$method" "$BASE_URL$url" 2>/dev/null) || http_code="000"
  if [[ "$http_code" == "$expected_status" ]]; then
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
  if command -v "$bin" &>/dev/null; then
    version=$("$bin" --version 2>&1 | head -1 || echo "unknown")
    pass "$bin found: $version"
  else
    warn "$bin not on PATH (sessions using this agent will fail)"
  fi
done

# -----------------------------------------------------------------------
# 5. Create + delete test (optional, gated)
# -----------------------------------------------------------------------
echo ""
echo "--- Write Test (create task + delete) ---"

# Only run if JWT_SECRET is available for auth, or if API has no auth
TASK_RESP=$(curl -sf -X POST "$BASE_URL/api/tasks" \
  -H "Content-Type: application/json" \
  -d '{"title":"[smoke-test] health check","description":"Auto-created by smoke test. Safe to delete.","priority":1}' \
  2>/dev/null) || TASK_RESP=""

if [[ -n "$TASK_RESP" ]]; then
  TASK_ID=$(echo "$TASK_RESP" | jq -r '.data.id // .id // empty')
  if [[ -n "$TASK_ID" ]]; then
    pass "Create task: $TASK_ID"
    # Clean up
    DEL_CODE=$(curl -sf -o /dev/null -w '%{http_code}' -X DELETE "$BASE_URL/api/tasks/$TASK_ID" 2>/dev/null) || DEL_CODE="000"
    [[ "$DEL_CODE" == "200" || "$DEL_CODE" == "204" ]] && pass "Delete task: cleaned up" || warn "Delete task: HTTP $DEL_CODE (manual cleanup needed)"
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

if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}Smoke test FAILED${NC}"
  exit 1
elif [[ $WARNINGS -gt 0 ]]; then
  echo -e "${YELLOW}Smoke test PASSED with warnings${NC}"
  exit 0
else
  echo -e "${GREEN}Smoke test PASSED${NC}"
  exit 0
fi
```

### What the smoke test does NOT do

- **Spawn an agent session** — too slow (>30s), requires API keys, non-idempotent. Leave this for manual QA or a separate integration test.
- **Test WebSocket/terminal** — requires ws client, adds complexity. Can be a separate script if needed.
- **Test SSE streaming** — curl can't easily validate SSE. Unit tests cover this.

---

## 3. Setup Script Integration

Add a verification step at the end of `scripts/setup.sh`:

```bash
# ---------------------------------------------------------------------------
# 8. Verify setup (optional — requires running server)
# ---------------------------------------------------------------------------

echo ""
echo "=== Setup complete! ==="
echo ""
echo "After starting the app, verify everything works:"
echo ""
echo "  ./scripts/smoke-test.sh"
echo ""
```

For `--dev` mode, we could add a lightweight pre-flight check that doesn't need the server running:

```bash
# Quick pre-flight (no server needed)
verify_preflight() {
  local ok=true

  # DB reachable?
  if ! pg_isready -q 2>/dev/null; then
    warn "PostgreSQL not reachable"
    ok=false
  fi

  # Agent binaries?
  local found=0
  for bin in claude codex gemini; do
    command -v "$bin" &>/dev/null && ((found++))
  done
  [[ $found -gt 0 ]] && info "$found agent CLI(s) found on PATH" || warn "No agent CLIs found on PATH"

  # MCP bundle?
  [[ -f dist/mcp-server.js ]] && info "MCP server bundle found" || warn "MCP server not built (run: pnpm build:mcp)"

  # Log dir writable?
  local log_dir="${LOG_DIR:-./logs}"
  [[ -w "$log_dir" ]] && info "Log directory writable: $log_dir" || warn "Log directory not writable: $log_dir"

  $ok
}
```

---

## 4. Status Page in the UI

**Recommendation: Yes, but as an admin panel tab, not a public page.**

### Approach: `/settings/system` or `/admin/health` route

A dedicated admin page that displays the detailed health response, refreshed on an interval. This is more useful than a standalone `/status` page because:

1. Agendo is self-hosted (single-user or small team) — no need for a public status page
2. The dashboard already shows task/session stats; system health belongs in settings/admin
3. It can show actionable info: "Worker stale — restart with `pm2 restart agendo-worker`"

### Sketch

```tsx
// src/app/(dashboard)/settings/system/page.tsx
export default async function SystemHealthPage() {
  // Server component — fetch health on render
  const health = await fetch(
    `http://localhost:${process.env.PORT ?? 4100}/api/health?detailed=true`,
    {
      cache: 'no-store',
    },
  ).then((r) => r.json());

  return (
    <div className="space-y-6">
      <h1>System Health</h1>
      <StatusBadge status={health.status} />

      <div className="grid grid-cols-2 gap-4">
        <HealthCard
          title="Database"
          status={health.checks.database.status}
          detail={`${health.checks.database.latencyMs}ms`}
        />
        <HealthCard
          title="Worker"
          status={health.checks.worker.status}
          detail={health.checks.worker.lastSeenAt}
        />
        <HealthCard
          title="Agents"
          status={health.checks.agents.count > 0 ? 'ok' : 'error'}
          detail={health.checks.agents.discovered.join(', ')}
        />
        <HealthCard
          title="Disk"
          status={health.checks.disk.status}
          detail={`${health.checks.disk.freeGB}GB free`}
        />
        <HealthCard
          title="Queue"
          status={health.checks.queue.status}
          detail={`${health.checks.queue.activeJobs} active, ${health.checks.queue.queuedJobs} queued`}
        />
        <HealthCard
          title="MCP Server"
          status={health.checks.mcp.exists ? 'ok' : 'warn'}
          detail={health.checks.mcp.exists ? 'Bundle found' : 'Not built'}
        />
      </div>
    </div>
  );
}
```

With a client component wrapper that auto-refreshes every 30s.

### Priority

Medium. The smoke test script + enhanced health endpoint cover the critical path. A UI status page is nice-to-have but not blocking for setup verification.

---

## 5. CI Integration (GitHub Actions)

### Strategy

| Layer           | What                          | Needs real PG?   | Speed |
| --------------- | ----------------------------- | ---------------- | ----- |
| **Lint + Type** | `pnpm lint && pnpm typecheck` | No               | ~30s  |
| **Unit tests**  | `pnpm test` (vitest)          | No (mocked)      | ~15s  |
| **Build**       | `pnpm build:all`              | No               | ~60s  |
| **Integration** | Health endpoint + API routes  | Yes (container)  | ~20s  |
| **Smoke test**  | `scripts/smoke-test.sh`       | Yes (full stack) | ~30s  |

### Workflow sketch

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  lint-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test

  build:
    runs-on: ubuntu-latest
    needs: lint-and-test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build:all

  smoke-test:
    runs-on: ubuntu-latest
    needs: build
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: agendo_test
          POSTGRES_USER: agendo
          POSTGRES_PASSWORD: agendo_test
        ports: ['5432:5432']
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    env:
      DATABASE_URL: postgresql://agendo:agendo_test@localhost:5432/agendo_test
      JWT_SECRET: ci-test-secret-at-least-16-chars
      LOG_DIR: /tmp/agendo-logs
      NODE_ENV: test
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build:all
      - run: pnpm db:setup
      - run: pnpm db:seed

      # Start app + worker in background
      - name: Start Agendo
        run: |
          node .next/standalone/server.js &
          node dist/worker/index.js &
          # Wait for app to be ready
          for i in $(seq 1 30); do
            curl -sf http://localhost:4100/api/health && break
            sleep 1
          done

      - name: Run smoke test
        run: ./scripts/smoke-test.sh http://localhost:4100
```

### What's mockable vs needs real PG

| Component        | Mockable? | Notes                                       |
| ---------------- | --------- | ------------------------------------------- |
| Service layer    | Yes       | Unit tests mock `db` via vitest             |
| API routes       | Partially | Can test handler logic with mocked services |
| Health endpoint  | No        | Needs real DB + pg-boss schema              |
| Worker heartbeat | No        | Needs real PG NOTIFY + pg-boss              |
| Agent discovery  | N/A       | Checks PATH — works anywhere                |
| MCP server       | Yes       | File existence check only                   |
| Smoke test       | No        | Full integration — needs running stack      |

### Recommended CI tiers

1. **PR checks** (every push): lint + typecheck + unit tests + build. Fast (~2 min). No PG needed.
2. **Integration** (merge to main): full smoke test with PG service container. Slower (~4 min) but catches real integration issues.
3. **Nightly** (optional): extended tests including session spawning with mock agents (future).

---

## 6. Summary of Recommendations

| Item                                            | Priority   | Effort  | Status                            |
| ----------------------------------------------- | ---------- | ------- | --------------------------------- |
| Enhance `GET /api/health` with `?detailed=true` | **High**   | Small   | Existing endpoint needs extension |
| `scripts/smoke-test.sh`                         | **High**   | Small   | New file                          |
| Add smoke test hint to `setup.sh`               | **High**   | Trivial | One-line addition                 |
| GitHub Actions CI workflow                      | **Medium** | Medium  | New `.github/workflows/ci.yml`    |
| Admin system health page                        | **Medium** | Medium  | New route + components            |
| Pre-flight checks in setup.sh                   | **Low**    | Small   | Enhancement to existing script    |

### Implementation order

1. Enhance health endpoint (the foundation everything else depends on)
2. Write smoke test script (immediate value for setup verification)
3. Update setup.sh to mention smoke test
4. CI workflow (once smoke test is stable)
5. UI status page (nice-to-have, can come later)

### Dependencies

- Health endpoint enhancement: none (pure addition)
- Smoke test: depends on enhanced health endpoint for `?detailed=true` checks
- CI: depends on smoke test + `pnpm build:all` working in clean environment
- UI page: depends on health endpoint schema being finalized
