# Health Check, Smoke Test, and Post-Setup Verification Analysis

This document outlines a strategy for implementing health checks and smoke tests to ensure Agendo is running correctly after setup.

## 1. Health Check Endpoint (`/api/health`)

A new API endpoint at `/api/health` will provide a fast, comprehensive overview of the system's status.

### Proposed Response Schema

The endpoint will return a JSON object with the status of critical components.

```json
{
  "status": "ok" | "degraded" | "error",
  "timestamp": "2026-03-18T12:00:00.000Z",
  "checks": {
    "database": {
      "status": "ok" | "error",
      "message": "Connected successfully" | "Connection failed: ..."
    },
    "worker": {
      "status": "ok" | "degraded" | "error",
      "message": "Last heartbeat 5s ago" | "No recent heartbeat" | "Worker not running",
      "lastHeartbeat": "2026-03-18T11:59:55.000Z"
    },
    "agentDiscovery": {
      "status": "ok" | "degraded" | "error",
      "message": "Found 3 agents" | "No agents found",
      "discoveredAgents": 3
    },
    "diskSpace": {
        "status": "ok" | "warning" | "error",
        "message": "150.5 GB free (75%)",
        "freeBytes": 161594277888,
        "totalBytes": 215458738176
    }
  }
}
```

### Implementation Sketch

The handler for `/api/health` would look something like this:

```typescript
// src/app/api/health/route.ts
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getWorkerStatus } from '@/lib/services/worker-status-service'; // To be created
import { getDiscoveredAgentCount } from '@/lib/services/agent-service';
import { getDiskSpace } from '@/worker/disk-check';

export async function GET() {
  const dbCheck = await db
    .execute(sql`SELECT 1`)
    .then(() => ({ status: 'ok', message: 'Connected successfully' }))
    .catch((e) => ({ status: 'error', message: e.message }));
  const workerStatus = await getWorkerStatus();
  const discoveredAgents = await getDiscoveredAgentCount();
  const diskSpace = await getDiskSpace();

  const checks = {
    database: dbCheck,
    worker: workerStatus,
    agentDiscovery: {
      status: discoveredAgents > 0 ? 'ok' : 'degraded',
      message: `Found ${discoveredAgents} agents`,
      discoveredAgents,
    },
    diskSpace,
  };

  const overallStatus = Object.values(checks).some((c) => c.status === 'error')
    ? 'error'
    : Object.values(checks).some((c) => c.status !== 'ok')
      ? 'degraded'
      : 'ok';

  return NextResponse.json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    checks,
  });
}
```

A new `worker-status-service` would be needed to check the last heartbeat from `pg-boss`.

## 2. Smoke Test Script

A `scripts/smoke-test.sh` script will be created to perform a quick end-to-end test.

### Script Outline

```bash
#!/usr/bin/env bash
set -euo pipefail

API_URL="http://localhost:${PORT:-4100}/api"

# 1. Check health endpoint
echo "Checking health..."
HEALTH=$(curl -sS ${API_URL}/health)
STATUS=$(echo $HEALTH | jq -r '.status')

if [[ "$STATUS" != "ok" ]]; then
  echo "Health check failed!"
  echo $HEALTH | jq
  exit 1
fi
echo "Health check OK."

# 2. Verify agent discovery
AGENT_COUNT=$(echo $HEALTH | jq -r '.checks.agentDiscovery.discoveredAgents')
if [[ "$AGENT_COUNT" -eq 0 ]]; then
    echo "Warning: No agents discovered."
fi
echo "$AGENT_COUNT agents discovered."


# 3. Create a test project and task
echo "Creating test task..."
PROJECT_ID=$(curl -sS -X POST ${API_URL}/projects -H "Content-Type: application/json" -d '{"name":"Smoke Test Project"}' | jq -r '.id')
TASK_ID=$(curl -sS -X POST ${API_URL}/tasks -H "Content-Type: application/json" -d '{"title":"Smoke Test Task", "projectId":"'$PROJECT_ID'"}' | jq -r '.id')
echo "Task $TASK_ID created in project $PROJECT_ID."

# 4. Clean up
echo "Cleaning up..."
curl -sS -X DELETE ${API_URL}/tasks/${TASK_ID} > /dev/null
curl -sS -X DELETE ${API_URL}/projects/${PROJECT_ID} > /dev/null
echo "Cleanup complete."

echo "Smoke test passed!"
```

This script would be non-destructive and safe to run at any time.

## 3. Status Page

A UI page at `/status` could display the health check information in a user-friendly format.

### Recommendations

- The page should call the `/api/health` endpoint.
- It should display the status of each component with clear icons (green check, yellow warning, red error).
- It should provide helpful troubleshooting advice for any failing component. For example, if the worker is down, it could suggest running `pm2 restart worker`.
- This page would be invaluable for users diagnosing setup issues.

## 4. CI Integration

The health checks and smoke tests should be integrated into the CI pipeline.

### Approach

- **Linting & Type-checking**: The `eslint.config.mjs` and `tsconfig.json` files already exist and can be used to set up linting and type-checking in the CI pipeline.
- **Unit tests**: The `vitest.config.ts` file suggests that the project is using Vitest for unit testing. The CI pipeline can be configured to run the `pnpm test` command to execute the unit tests.
- **Health Check**: After building the application, the CI can start the server and run a `curl` command against the `/api/health` endpoint to ensure the system is in a good state. A real PostgreSQL instance would be required for this.
- **Smoke Test**: The `scripts/smoke-test.sh` script can be executed as part of the CI pipeline to perform a quick end-to-end test. This would also require a running instance of the application and database.
- **E2E Tests**: The `playwright.config.ts` file in the `.playwright-mcp` directory suggests that the project is using Playwright for end-to-end testing. The CI pipeline can be configured to run the `pnpm test:e2e` command to execute the E2E tests.

By integrating these checks into the CI pipeline, we can catch issues early and ensure the stability of the application.
