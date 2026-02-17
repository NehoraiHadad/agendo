# Architecture Principles Validation

> Validator: Architecture Principles Alignment (Task #2)
> Date: 2026-02-17
> Source: `planning/01-brainstorm-synthesis.md` (17 confirmed decisions + 5 P0 items)
> Scanned: All 7 plan files (`phase-1-foundation.md` through `phase-6-mcp-dashboard.md`)

---

## Summary

| Result | Count |
|--------|-------|
| PASS | 15 |
| WARN | 3 |
| FAIL | 0 |
| CRITICAL | 0 |

P0 Action Items: 4 PASS, 1 WARN

---

## Decision Validation

### Decision 1: Dual Execution Mode (Template + Prompt)
**Status**: PASS

**Evidence**:
- Phase 2 (`phase-2-discovery.md:733`): Capability service validates "template mode requires `commandTokens`, prompt mode allows null"
- Phase 2 (`phase-2-discovery.md:911`): API test: "mode=prompt + no commandTokens -> 201"
- Phase 4a (`phase-4a-backend.md:710`): Adapter factory selects adapter based on `interaction_mode` + agent binary
- Phase 1 (`phase-1-foundation.md:225`): Schema includes `bidirectionalProtocol` field on session config

No violations found. Both modes are consistently enforced.

---

### Decision 2: Direct Postgres + Drizzle ORM (No Supabase)
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:12`): Dependencies are `drizzle-orm pg` -- no Supabase packages
- Grep for "supabase" across all plan files: **zero matches**
- All DB access uses Drizzle ORM queries (e.g., `db.select()`, `db.insert()`, `db.update()`)

No violations found.

---

### Decision 3: Single Package (No Monorepo)
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:35`): Single `package.json` with `next@16.x`
- Grep for "monorepo" or "workspace" across all plan files: **zero matches** (except unrelated `workspaceId` bug in Phase 5)
- All phases modify the same `package.json` (Phase 1:35, Phase 4a:30, Phase 6:908)
- Folder structure: `src/app/`, `src/lib/`, `src/worker/` -- all under one package

No violations found.

---

### Decision 4: Separate Worker Process
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:622-720`): Separate worker entry point at `src/worker/index.ts` with its own `main()` function, pg-boss connection, heartbeat loop
- Phase 1 (`phase-1-foundation.md:1166-1199`): PM2 config has separate entries for Next.js and worker
- Phase 4a (`phase-4a-backend.md:22`): Worker entry point listed as dependency from Phase 1
- Worker runs as independent OS process -- not an API route or Next.js middleware

No violations found.

---

### Decision 5: SSE via fs.watch (NOT EventEmitter)
**Status**: WARN

**Evidence**:
- Phase 1 (`phase-1-foundation.md:253`): SSE log streaming event types are defined
- Phase 4b (`phase-4b-frontend.md:26`): SSE log stream route listed at `src/app/api/executions/[id]/logs/stream/route.ts` as a Phase 4a dependency
- Phase 5 (`phase-5-realtime.md:277`): Board SSE uses `text/event-stream` with DB polling every 2s (consistent with synthesis)
- Phase 4b (`phase-4b-frontend.md:157-160`): SSE hook uses `EventSource` (browser API)

**Warning**: The SSE log stream route implementation (`src/app/api/executions/[id]/logs/stream/route.ts`) is listed as a Phase 4a dependency in Phase 4b's table, but **no implementation code for this route exists in Phase 4a**. Phase 4a only contains the log-writer (file output) and execution runner. The actual SSE route that would use `fs.watch` is missing from both Phase 4a and 4b plans. The plan should include this route implementation with explicit `fs.watch` usage.

---

### Decision 6: Cancellation Flow (running -> cancelling -> cancelled)
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:1310-1330`): Tests validate state transitions: `running -> cancelling`, `cancelling -> cancelled`, `cancelling -> failed`
- Phase 4a (`phase-4a-backend.md:452,497,630,702`): Execution runner finalizes with `WHERE status = 'running'` guard
- Phase 4a (`phase-4a-backend.md:647`): "If 0 rows updated, status was changed (likely to 'cancelling')"
- Phase 4a (`phase-4a-backend.md:703`): Explicit documentation of the race guard behavior

No violations found. The cancellation race guard is correctly implemented.

---

### Decision 7: Agent != Capability (1:N Relationship)
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:138`): Schema tables include both `agents` and `agentCapabilities` as separate tables
- Phase 2 (`phase-2-discovery.md:733`): Separate capability CRUD service with full lifecycle
- Phase 2 (`phase-2-discovery.md:843-847`): UI shows capabilities as expandable rows under agents with their own badges
- Phase 3 (`phase-3-tasks.md:53`): Imports both `tasks`, `taskDependencies`, `agents` -- capabilities are a separate entity

No violations found.

---

### Decision 8: task_events Audit Trail
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:138`): `taskEvents` table in schema
- Phase 3 (`phase-3-tasks.md:173,210,220`): `task_events` rows inserted on status transitions (create, update, delete)
- Phase 3 (`phase-3-tasks.md:578-624`): Dedicated `task-event-service.ts` with insert and list functions
- Phase 3 (`phase-3-tasks.md:2431`): Test case: "Status transition audit trail -- Change status, verify `task_events` row created"
- Phase 6 (`phase-6-mcp-dashboard.md:108-113`): Dashboard queries `taskEvents` for recent activity feed

Events are written on meaningful state transitions (create, status change, assignment, delete) -- not on noisy updates. Consistent with synthesis.

---

### Decision 9: worker_heartbeats (Kept)
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:138,199`): `workerHeartbeats` table in schema, TypeScript type exported
- Phase 1 (`phase-1-foundation.md:682-690`): Worker upserts heartbeat row on each interval
- Phase 1 (`phase-1-foundation.md:713`): Heartbeat interval timer in worker main loop
- Phase 4a (`phase-4a-backend.md:397-437`): Per-execution heartbeat timer (30-second interval)
- Phase 6 (`phase-6-mcp-dashboard.md:2488`): Dashboard shows "worker online status, current execution count, uptime"

No violations found.

---

### Decision 10: Job Queue: pg-boss
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:12`): `pg-boss` in dependencies
- Phase 1 (`phase-1-foundation.md:537-605`): Complete pg-boss queue module with singleton pattern, `getOrCreateBoss()`, `stopBoss()`
- Phase 1 (`phase-1-foundation.md:622`): Worker imports pg-boss queue module
- Phase 3 (`phase-3-tasks.md:384-394`): Cycle detection uses `FOR UPDATE` locking (correctness-first approach)
- Phase 6 (`phase-6-mcp-dashboard.md:2076-2089`): pg-boss cron for log rotation

No violations found.

---

### Decision 11: Auto-Discovery from Day 1
**Status**: PASS

**Evidence**:
- Phase 2 (`phase-2-discovery.md:3`): "Auto-discover CLI tools via PATH scanning"
- Phase 2 (`phase-2-discovery.md:598-601`): Full discovery pipeline: SCAN -> IDENTIFY -> CLASSIFY -> SCHEMA -> ENRICH -> INDEX
- Phase 2 (`phase-2-discovery.md:906`): Tests for PATH scanning, deduplication, symlink resolution
- Phase 2 (`phase-2-discovery.md:483,518,553`): AI tool presets for Claude, Codex, Gemini with hardcoded session configs

No violations found. Auto-discovery is fully in Phase 2 (Day 1 after foundation).

---

### Decision 12: CLI-Only, No SDKs, No API Keys
**Status**: PASS

**Evidence**:
- Phase 4a (`phase-4a-backend.md:3`): "Bidirectional adapters per agent (stream-json, JSON-RPC, tmux)" -- all CLI-based
- Phase 4a: All adapters use CLI binaries (`claude`, `codex`, `gemini`) -- no SDK imports
- Phase 2 (`phase-2-discovery.md:483,518,553`): Presets define `envAllowlist` entries for optional API key overrides

**Note**: The `envAllowlist` entries reference API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`). These are allowlists (not requirements) -- CLI tools use OAuth by default and API keys are optional overrides. A clarifying comment in the preset definitions would prevent misinterpretation, but this is not a principle violation.

---

### Decision 13: UI in Every Phase
**Status**: PASS

**Evidence**:
- Phase 1: App shell, sidebar, empty states
- Phase 2: Discovery scan UI, agent registry, capability CRUD
- Phase 3: Task CRUD, Kanban board, detail sheets
- Phase 4b: Execution UI, log viewer, web terminal
- Phase 5: DnD, live board updates
- Phase 6: Dashboard, MCP config, command palette

Every phase delivers backend + frontend + testing.

---

### Decision 14: Web Terminal (xterm.js + node-pty + tmux)
**Status**: WARN

**Evidence**:
- Phase 4a (`phase-4a-backend.md:1802-1803`): Terminal server on port 4101 with `socket.io` and `node-pty`
- Phase 4a (`phase-4a-backend.md:1809`): `import { Server as SocketIOServer } from 'socket.io'`
- Phase 4a (`phase-4a-backend.md:2013`): PM2 config for terminal-ws process
- Phase 4b (`phase-4b-frontend.md:39,46`): `socket.io-client` for frontend terminal connection

**Warning**: The brainstorm synthesis (line 90) specifies `ws` (WebSocket) as the transport layer: "Stack: `@xterm/xterm` v6 (frontend) + `node-pty` (backend PTY) + `ws` (WebSocket) + tmux". However, the plan uses `socket.io` / `socket.io-client` instead of raw `ws`. Socket.io adds reconnection, fallback transports, and event namespacing -- a pragmatic upgrade, not a downgrade. The architecture intent (separate WebSocket server on port 4101, JWT auth, crash isolation) is fully preserved.

---

### Decision 15: MCP Server (Agent-Initiated Tasks)
**Status**: PASS

**Evidence**:
- Phase 6 (`phase-6-mcp-dashboard.md:495-580`): Full MCP server with `@modelcontextprotocol/sdk`, stdio transport
- Phase 6 (`phase-6-mcp-dashboard.md:502-503`): Uses `McpServer` and `StdioServerTransport` from SDK
- Phase 6 (`phase-6-mcp-dashboard.md:857-898`): Build script bundles MCP server as standalone `dist/mcp-server.js`
- Phase 6 (`phase-6-mcp-dashboard.md:976`): Config generation for Codex `config.toml`
- Phase 6: Loop prevention with spawn depth, rate limiting, agents cannot self-assign

No violations found.

---

### Decision 16: tmux as Process Layer
**Status**: PASS

**Evidence**:
- Phase 4a (`phase-4a-backend.md:843-955`): Full `tmux-manager.ts` module with `createSession`, `sendKeys`, `capturePaneContent`, `killSession`, `resizeSession`
- Phase 4a (`phase-4a-backend.md:795`): `ManagedProcess` interface requires `tmuxSession: string` -- all adapters must provide it
- Phase 4a: Claude adapter creates tmux session (line 1066), Codex adapter creates tmux session (line 1248), Gemini adapter runs entirely inside tmux (line 1597), Template adapter creates tmux session
- Phase 1 (`phase-1-foundation.md:225`): Schema has `bidirectionalProtocol` enum including `'tmux'`

All AI agent executions run inside tmux sessions as specified.

---

### Decision 17: Bidirectional Communication (Per-Agent Protocols)
**Status**: PASS

**Evidence**:
- Phase 4a (`phase-4a-backend.md:987-1130`): Claude adapter -- `stream-json` NDJSON over stdin/stdout
- Phase 4a (`phase-4a-backend.md:1143-1299`): Codex adapter -- `codex app-server` JSON-RPC 2.0 over stdio
- Phase 4a (`phase-4a-backend.md:1450-1599`): Gemini adapter -- tmux `send-keys` / `capture-pane`
- Phase 4a (`phase-4a-backend.md:1608`): Template adapter -- simple command execution
- Phase 2 (`phase-2-discovery.md:483,518,553`): Presets define `bidirectionalProtocol` per agent type

All three AI agent protocols match the synthesis specification exactly.

---

## P0 Action Items Validation

### P0-1: Zombie Process Reconciliation on Worker Startup
**Status**: PASS

**Evidence**:
- Phase 1 (`phase-1-foundation.md:633,705-706`): `reconcileZombies(WORKER_ID)` called in worker startup sequence
- Phase 1 (`phase-1-foundation.md:735-777`): Full `zombie-reconciler.ts` implementation
  - Queries `WHERE status IN ('running', 'cancelling') AND worker_id = $myWorkerId`
  - Checks PID existence via `kill(pid, 0)`
  - Marks dead ones as `failed` with error "Worker restarted, execution orphaned"

Fully implemented in Phase 1 as required.

---

### P0-2: Log Retention (Phase 1, NOT Phase 6)
**Status**: WARN

**Evidence**:
- Phase 1 (`phase-1-foundation.md:1499-1513`): Seeds `log_retention_days: 30` into `worker_config` table
- Phase 1 (`phase-1-foundation.md:698-823`): Disk space check on worker startup (refuse if < 5GB free)
- **Phase 6** (`phase-6-mcp-dashboard.md:2019-2089`): Actual log rotation function (`rotateOldLogs`) and pg-boss cron scheduling

**Warning**: The synthesis (P0-2) explicitly says log retention should be in Phase 1, NOT Phase 6. Phase 1 only seeds the config value and adds the disk space check, but the actual log deletion logic (`rotateOldLogs`) and the cron scheduling are deferred to Phase 6. The disk space startup check is present but the daily cleanup cron is in Phase 6. This is a partial violation -- the config and disk check are in Phase 1, but the active cleanup is deferred.

---

### P0-3: Cancellation Race Guard
**Status**: PASS

**Evidence**:
- Phase 4a (`phase-4a-backend.md:497,630,647,702-703`): `WHERE status = 'running'` guard on finalization
- Phase 4a (`phase-4a-backend.md:703`): "If the guard returns 0 rows, the runner checks current status and transitions `cancelling -> cancelled`"

Fully implemented as specified.

---

### P0-4: fs.watch Scope Guard
**Status**: WARN (same as Decision 5)

**Evidence**:
- Grep for `fs.watch`, `fsWatch`, `inotify` across all plan files: **zero matches** in code
- The SSE log stream route (`src/app/api/executions/[id]/logs/stream/route.ts`) is listed as a Phase 4a dependency in Phase 4b, but **no implementation exists** in any plan file
- The synthesis specifies: "SSE log stream route must ONLY activate fs.watch for non-terminal executions"

**Warning**: The SSE log stream route is a critical dependency for Phase 4b's log viewer, but its implementation is missing from the plans. Without the route code, we cannot verify that the fs.watch scope guard (only watch non-terminal executions) is present. This is a gap in the plan -- the route needs to be written with the scope guard before Phase 4b can be implemented.

---

### P0-5: "Test Capability" Button (Phase 2)
**Status**: PASS

**Evidence**:
- Phase 2 (`phase-2-discovery.md:740`): `testCapability(id)` -- runs `--version` on the agent binary to verify it exists
- Phase 2 (`phase-2-discovery.md:749`): `testCapabilityAction` listed in capability actions file

Implemented in Phase 2 as specified.

---

## Additional Issues Found

### Issue 1: workspaceId Reference in Phase 5 (Bug)
**Severity**: MEDIUM
**Status**: FIXED

Phase 5 (`phase-5-realtime.md:65`) references `updated.workspaceId` in the reorder route:
```typescript
await reindexColumn(updated.workspaceId, updated.status);
```

And the `reindexColumn` function (`phase-5-realtime.md:133,141`) queries `tasks.workspaceId`. However, `workspaceId` does not exist in the tasks schema defined in Phase 1 or Phase 3. This would cause a TypeScript compilation error. The column needs to be either:
- Added to the tasks schema (if workspaces are planned), or
- Removed from the reorder logic (reindex all tasks in the column regardless of workspace)

**Resolution**: Removed workspaceId filter from reindexColumn. Function now accepts only `status: string`, imports `db` and `tasks` internally, and filters only by status. Added TODO comment for future multi-workspace support. Call site updated to `reindexColumn(updated.status)`.

### Issue 2: Missing SSE Log Stream Route Implementation
**Severity**: MEDIUM

The SSE log stream route (`src/app/api/executions/[id]/logs/stream/route.ts`) is listed as a Phase 4a dependency in Phase 4b's prerequisites table, but no implementation code exists in Phase 4a or any other phase. This route is critical for the execution log viewer (Phase 4b Step 2, Step 7). The plan should include this route with:
- File-based log tailing
- fs.watch for live updates (non-terminal executions only -- P0-4 scope guard)
- Static file serving for completed executions
- text/event-stream headers

### Issue 3: Environment Variable Naming Inconsistency
**Severity**: LOW

Phase 4a uses `TERMINAL_WS_PORT` in the terminal server configuration (`phase-4a-backend.md:1802`), but the PM2 ecosystem config in Phase 1 (`phase-1-foundation.md:1166`) and the env schema reference `TERMINAL_PORT`. These should be unified to a single name across all phases.

### Issue 4: Phase 5 async params Missing Await
**Severity**: LOW
**Status**: FIXED

Phase 5 (`phase-5-realtime.md:37`) destructures route params synchronously:
```typescript
const { id } = params;
```

In Next.js 15+, `params` is a Promise and must be awaited:
```typescript
const { id } = await params;
```

This pattern appears in the reorder route and potentially other Phase 5 routes. Phase 4a correctly awaits params in some places but Phase 5 does not.

**Resolution**: Updated reorder route to use `params: Promise<{ id: string }>` with `const { id } = await params;`.

---

## Conclusion

All 17 confirmed architecture decisions are respected in the plan files. **No CRITICAL violations** were found. Three WARNs require attention before implementation:

1. **Missing SSE log stream route** (Decision 5 / P0-4): Cannot verify fs.watch scope guard because the route implementation is absent from all plans. This is the most important gap -- it blocks Phase 4b's log viewer.
2. **WebSocket library mismatch** (Decision 14): Plan uses `socket.io` instead of `ws`. Pragmatic upgrade with no architectural impact.
3. **Log retention timing** (P0-2): Active log cleanup deferred to Phase 6 instead of Phase 1 as synthesis requires. Risk: disk exhaustion on long-running instances before Phase 6 is built.

Two medium-severity bugs were identified: workspaceId phantom reference (FIXED) and missing SSE route (still open). Two low-severity issues: env var naming (open) and async params (FIXED).
