# Agent Monitor — Implementation Prompts

> Paste each prompt into a **fresh Claude Code session** in the project directory `/home/ubuntu/projects/agent-monitor/`.
> Run them **sequentially** (Phase 1 first, then 2, etc.). Each session starts in plan mode.
> After each phase: verify the app runs, tests pass, then commit before starting the next.

---

## Prompt 1: Phase 1 — Foundation + App Shell

```
Implement Phase 1 of the Agent Monitor project — a Next.js 16 application for managing AI coding agents.

## What to Build

Follow the plan file exactly: `plan/phase-1-foundation.md`

Reference docs (source of truth for types/columns/enums):
- `planning/03-data-model.md` — Drizzle ORM schema (THE authority for table/column/type names)
- `planning/02-architecture.md` — system architecture
- `planning/01-brainstorm-synthesis.md` — confirmed decisions

## Deliverables

1. Next.js 16 project scaffold with TypeScript strict mode
2. Full Drizzle ORM schema (ALL tables: agents, agent_capabilities, tasks, task_dependencies, task_events, executions, worker_heartbeats, worker_config)
3. Database migration + seed script
4. Zod-validated environment config (`src/lib/config.ts`)
5. State machines for task and execution status transitions
6. Error hierarchy (`AppError`, `NotFoundError`, `ValidationError`, `ConflictError`)
7. API handler wrapper (`withErrorBoundary`) with typed response envelopes
8. pg-boss queue module (singleton pattern)
9. Worker entry point (`src/worker/index.ts`) with heartbeat loop and zombie reconciler
10. Navigable app shell: sidebar with nav links, layout, empty pages for Dashboard, Agents, Tasks, Executions
11. shadcn/ui init + all components listed in the plan
12. PM2 ecosystem config
13. Unit tests for state machines, config validation, error hierarchy

## Team Structure

Use a team of agents. Suggested split:
- **backend-1**: Steps 1-6 (scaffold, schema, migration, config, state machines, errors, api-handler, types)
- **backend-2**: Steps 7-9 (pg-boss queue, worker entry point, heartbeat, zombie reconciler)
- **frontend**: Steps 10-11 (shadcn init, app shell, sidebar, layout, empty pages)
- **infra**: Step 12 (PM2 config, seed script) + Step 13 (tests)

## Quality Standards

These standards apply to ALL code in this project. Follow them rigorously:

1. **TypeScript strict mode** — no `any`, no `@ts-ignore`, no type assertions unless absolutely unavoidable (and then add a comment explaining why)
2. **Drizzle ORM only** — no raw SQL unless Drizzle can't express the query. Never use Supabase.
3. **03-data-model.md is THE authority** — table names, column names, enum values, and types must match exactly. Do not invent columns or rename fields.
4. **Modular file structure** — one concern per file. Services are thin wrappers around DB queries. No god files.
5. **Named exports only** — no default exports (except Next.js pages/layouts/routes which require them)
6. **Consistent patterns** — every service follows the same structure: import db + schema, export async functions, use typed params and returns
7. **Error handling** — use the AppError hierarchy. Never swallow errors. API routes use withErrorBoundary.
8. **No over-engineering** — don't add abstractions, feature flags, or config for hypothetical future needs. Build exactly what the plan says.
9. **Clean imports** — group by: node builtins, external packages, internal aliases (@/). No circular dependencies.
10. **Readable code** — descriptive variable names, small functions, comments only where logic isn't self-evident
11. **No orphaned code** — if you create a function, it must be imported somewhere. If you create a type, it must be used.
12. **Test what matters** — unit tests for business logic (state machines, validation). No tests for trivial getters.

## Environment

- Server: Oracle Cloud, 4 CPU, 16GB RAM
- PostgreSQL is running locally
- pnpm is the package manager
- PM2 manages processes (see ecosystem config in the plan)
- Port 4100 for Next.js dev server (NOT 3000 — port 3000 is taken)
- NEVER run `pnpm dev` directly — use `pm2 restart agent-monitor` after setup

## After Implementation

1. Run `pnpm build` — must succeed with zero errors
2. Run `pnpm test` — all tests must pass
3. Verify database migration works: `pnpm drizzle-kit push`
4. Verify the app shell renders with sidebar navigation
5. Verify worker starts and sends heartbeats
```

---

## Prompt 2: Phase 2 — Agent Auto-Discovery + Registry

```
Implement Phase 2 of the Agent Monitor project — Agent Auto-Discovery and Registry.

## What to Build

Follow the plan file exactly: `plan/phase-2-discovery.md`

Reference docs (source of truth):
- `planning/03-data-model.md` — Drizzle schema authority
- `planning/02-architecture.md` — architecture decisions

## Context

Phase 1 is complete. The database schema, config, state machines, error hierarchy, API handler, worker, and app shell are all in place. You can read the existing code to understand patterns.

## Deliverables

1. PATH scanner (`src/lib/discovery/scanner.ts`) — scan $PATH for executables, deduplicate, resolve symlinks
2. Agent classifier (`src/lib/discovery/classifier.ts`) — identify known AI tools (Claude, Codex, Gemini) vs generic CLI tools
3. Schema extractor (`src/lib/discovery/schema-extractor.ts`) — extract --help output, parse capabilities
4. AI tool presets (`src/lib/discovery/presets.ts`) — hardcoded configs for Claude, Codex, Gemini with session configs
5. Discovery orchestrator (`src/lib/discovery/orchestrator.ts`) — pipeline: SCAN -> IDENTIFY -> CLASSIFY -> SCHEMA -> ENRICH -> INDEX
6. Agent service (`src/lib/services/agent-service.ts`) — CRUD for agents table
7. Capability service (`src/lib/services/capability-service.ts`) — CRUD for agent_capabilities, including testCapability
8. API routes: `/api/agents`, `/api/agents/[id]`, `/api/capabilities`, `/api/capabilities/[id]`, `/api/discovery/scan`
9. Agents page UI: agent list with expandable capability rows, scan button, agent detail with edit
10. Capability CRUD UI: add/edit capability forms using react-hook-form
11. Tests: discovery pipeline, agent service, capability service

## Team Structure

Use a team of agents:
- **discovery**: Steps 1-5 (scanner, classifier, schema-extractor, presets, orchestrator)
- **backend**: Steps 6-8 (agent-service, capability-service, all API routes)
- **frontend**: Steps 9-10 (agents page, scan UI, agent detail, capability forms)
- **tests**: Step 11 (tests for discovery, services, API routes)

## Quality Standards

Follow the SAME quality standards from Phase 1. Additionally:
- **Match existing patterns** — read how Phase 1 code is structured (services, API routes, error handling) and follow the exact same patterns
- **Discovery is server-side only** — all PATH scanning runs in Node.js, never in the browser
- **Agent presets must match 03-data-model.md** — field names like `sessionConfig`, `bidirectionalProtocol`, `interactionMode` must be exact
- **react-hook-form + zod** for all forms — no uncontrolled inputs
- **Server Actions or API routes** for mutations — never call DB from client components

## Important Notes

- Next.js 16: `params` is a Promise — use `const { id } = await params;` in all dynamic routes
- The discovery scan should be idempotent — running it twice should not create duplicate agents
- Capability `source` field must use values from `capabilitySourceEnum` in the data model
- Agent `kind` must be `'builtin'` for AI presets, `'custom'` for user-added agents

## After Implementation

1. `pnpm build` — zero errors
2. `pnpm test` — all tests pass
3. Navigate to /agents — should show empty state
4. Trigger a scan — should discover available CLI tools on the system
5. View an agent detail page — should show capabilities
```

---

## Prompt 3: Phase 3 — Task Management + Kanban Board

```
Implement Phase 3 of the Agent Monitor project — Task Management and static Kanban Board.

## What to Build

Follow the plan file exactly: `plan/phase-3-tasks.md`

Reference docs (source of truth):
- `planning/03-data-model.md` — Drizzle schema authority
- `planning/02-architecture.md` — architecture decisions

## Context

Phases 1-2 are complete. Database schema, agents, capabilities, discovery pipeline, and the app shell are all working. Read existing service code to match patterns.

## Deliverables

1. Task service (`src/lib/services/task-service.ts`) — full CRUD: createTask, updateTask, deleteTask, getTaskById, listTasks with filters
2. Task event service (`src/lib/services/task-event-service.ts`) — audit trail: insertEvent, listEvents
3. Dependency service (`src/lib/services/dependency-service.ts`) — add/remove dependencies with cycle detection (DFS + FOR UPDATE locking)
4. Sort-order utilities (`src/lib/sort-order.ts`) — computeSortOrder, needsReindex, reindexColumn for Kanban ordering
5. API routes: `/api/tasks`, `/api/tasks/[id]`, `/api/tasks/[id]/dependencies`, `/api/tasks/[id]/subtasks`, `/api/tasks/[id]/events`
6. Zustand store (`src/stores/task-board-store.ts`) — board state with column grouping
7. Kanban board page (`/tasks`) — columns for each task status, task cards with badges
8. Task detail sheet (slide-over) — full task info, edit form, dependency list, event timeline, subtask list
9. Task quick-add — inline form at bottom of each column
10. Tests: task service (CRUD, transitions, validation), dependency service (cycle detection), sort-order utils

## Team Structure

Use a team of agents:
- **backend**: Steps 1-5 (task-service, event-service, dependency-service, sort-order utils, all API routes)
- **frontend**: Steps 6-9 (Zustand store, Kanban board, task detail sheet, quick-add)
- **tests**: Step 10 (all tests)

## Quality Standards

Follow the SAME quality standards from Phase 1-2. Additionally:
- **Status transitions use `isValidTaskTransition()`** from `src/lib/state-machines.ts` — never check transitions manually
- **Cycle detection** must use DFS with `FOR UPDATE` row locking — this is critical for data integrity
- **Sort order** uses fractional indexing (midpoint between neighbors) — see `computeSortOrder` in the plan
- **Task events** are written on meaningful state changes (create, status change, assignment, delete) — not on every field update
- **Kanban board** is a Server Component that fetches initial data, with client interactivity via Zustand
- **Task detail sheet** uses shadcn Sheet component — slides in from the right, doesn't navigate away

## Important Notes

- `assigneeAgentId` is a UUID FK to agents table — the UI needs an agent dropdown populated from agent-service
- `parentTaskId` enables subtask hierarchy — subtasks appear nested under parent tasks
- `sortOrder` is a float column — use fractional indexing, not integer reindexing on every move
- Task deletion should soft-verify no running executions depend on it

## After Implementation

1. `pnpm build` — zero errors
2. `pnpm test` — all tests pass
3. Navigate to /tasks — should show empty Kanban board with columns
4. Create a task via quick-add — should appear in the correct column
5. Open task detail sheet — should show all fields, edit form works
6. Change task status — should move card to new column, create audit event
7. Test cycle detection — adding a circular dependency should fail with clear error
```

---

## Prompt 4: Phase 4a — Execution Engine Backend

```
Implement Phase 4a of the Agent Monitor project — Execution Engine and Bidirectional Agent Communication (Backend).

## What to Build

Follow the plan file exactly: `plan/phase-4a-backend.md`

Reference docs (source of truth):
- `planning/03-data-model.md` — Drizzle schema authority
- `planning/02-architecture.md` — architecture (especially SSE/fs.watch pattern, terminal server)
- `planning/04-phases.md:254-265` — expected API routes list

## Context

Phases 1-3 are complete. Database, agents, capabilities, tasks, and Kanban board are all working. The worker process runs via PM2. Read existing patterns carefully.

## Deliverables

1. Safety module (`src/lib/execution/safety.ts`) — working dir validation using `allowedWorkingDirs` from config, command sanitization
2. Log writer (`src/lib/execution/log-writer.ts`) — append-only file writer for execution logs
3. Heartbeat manager (`src/lib/execution/heartbeat.ts`) — per-execution heartbeat updates to DB
4. Execution runner (`src/lib/execution/execution-runner.ts`) — orchestrates: safety check -> spawn -> adapter -> monitor -> finalize
5. Bidirectional adapters:
   - Claude adapter (`src/lib/execution/adapters/claude-adapter.ts`) — stream-json NDJSON over stdin/stdout
   - Codex adapter (`src/lib/execution/adapters/codex-adapter.ts`) — JSON-RPC 2.0 via `codex app-server`
   - Gemini adapter (`src/lib/execution/adapters/gemini-adapter.ts`) — tmux send-keys/capture-pane
   - Template adapter (`src/lib/execution/adapters/template-adapter.ts`) — simple command execution
   - Adapter factory (`src/lib/execution/adapters/index.ts`) — selects adapter by agent binary + interaction mode
6. tmux manager (`src/lib/execution/tmux-manager.ts`) — createSession, sendKeys, capturePaneContent, killSession, resizeSession
7. Execution service (`src/lib/services/execution-service.ts`) — createExecution, cancelExecution, getExecutionById, listExecutions
8. API routes:
   - `/api/executions` (GET list, POST create)
   - `/api/executions/[id]` (GET detail)
   - `/api/executions/[id]/cancel` (POST)
   - `/api/executions/[id]/message` (POST send follow-up message)
   - `/api/executions/[id]/logs/stream` (GET SSE — fs.watch for live tailing, scope guard: non-terminal only)
   - `/api/workers/status` (GET worker health)
9. Terminal server (`src/terminal/server.ts` + `src/terminal/auth.ts`) — socket.io + node-pty on port 4101, JWT auth
10. Terminal token API route (`/api/terminal/token`)
11. Tests: safety module, execution runner, adapters (mocked)

## Team Structure

Use a team of agents:
- **execution-core**: Steps 1-4 (safety, log-writer, heartbeat, execution-runner)
- **adapters**: Steps 5-6 (all 4 adapters, adapter factory, tmux-manager)
- **api-service**: Steps 7-8 (execution-service CRUD, ALL API routes including SSE)
- **terminal**: Steps 9-10 (terminal server, auth, token route)
- **tests**: Step 11

## Quality Standards

Follow the SAME quality standards from previous phases. Additionally:
- **Safety is non-negotiable** — `validateWorkingDir` must resolve paths and check against `allowedWorkingDirs` (the parsed array from config, NOT `config.ALLOWED_WORKING_DIRS` which is a string)
- **Cancellation race guard** — when finalizing, use `WHERE status = 'running'` guard. If 0 rows updated, check for 'cancelling' and transition to 'cancelled'
- **fs.watch scope guard** — SSE log stream must ONLY activate fs.watch for non-terminal executions (P0-4). Completed executions serve the static file.
- **All adapters run inside tmux** — the ManagedProcess interface requires `tmuxSession: string`
- **`agent.workingDir`** — working directory comes from the agents table, NOT from capabilities
- **`execution.mode`** — this column EXISTS on the executions table (copied from capability at creation time)
- **Terminal server** is a separate process on port 4101, managed by PM2, JWT-authenticated

## Critical: C-09 is a FALSE POSITIVE

The validation report C-09 claims `execution.mode` doesn't exist. It DOES exist at `planning/03-data-model.md:214`. The execution runner correctly uses `execution.mode` to dispatch to the right adapter mode.

## After Implementation

1. `pnpm build` — zero errors
2. `pnpm test` — all tests pass
3. Worker can pick up a queued execution and run it
4. Execution logs are written to disk and streamable via SSE
5. Cancel an execution — verify running -> cancelling -> cancelled flow
6. Terminal server starts on port 4101 and accepts WebSocket connections
```

---

## Prompt 5: Phase 4b + Phase 5 — Execution Frontend + Real-Time Board

```
Implement Phase 4b AND Phase 5 of the Agent Monitor project.

Phase 4b: Execution engine frontend (log viewer, trigger dialog, web terminal).
Phase 5: Drag-and-drop Kanban + real-time board updates via SSE.

## What to Build

Follow the plan files exactly:
- `plan/phase-4b-frontend.md` (Phase 4b)
- `plan/phase-5-realtime.md` (Phase 5)

Reference: `planning/03-data-model.md` — schema authority

## Context

Phases 1-4a are complete. All backend services, API routes, execution engine, adapters, and terminal server are working. Read existing frontend patterns from the agents page and task board.

## Phase 4b Deliverables

1. ANSI log renderer (`src/lib/log-renderer.ts`) — convert ANSI escape codes to sanitized HTML
2. SSE hook (`src/hooks/use-execution-stream.ts`) — EventSource wrapper for log streaming
3. Execution status badge (`src/components/execution/execution-status-badge.tsx`)
4. Execution cancel button (`src/components/execution/execution-cancel-button.tsx`)
5. Execution trigger dialog (`src/components/execution/execution-trigger-dialog.tsx`) — select capability, set params, launch
6. Execution log viewer (`src/components/execution/execution-log-viewer.tsx`) — live ANSI-rendered logs with auto-scroll
7. Execution log toolbar (`src/components/execution/execution-log-toolbar.tsx`) — wrap/search/download controls
8. Execution table (RSC) (`src/components/execution/execution-table.tsx`) — server component listing executions
9. Execution row (`src/components/execution/execution-row.tsx`) — individual row with status, timing, actions
10. Execution detail page (`/executions/[id]`) — full log viewer + metadata + message input
11. Execution list page (`/executions`) — filterable table of all executions
12. Web terminal component (`src/components/terminal/web-terminal.tsx`) — xterm.js + socket.io-client
13. Terminal page (`/terminal/[sessionId]`) — full-screen terminal view

## Phase 5 Deliverables

14. Reorder API route (`/api/tasks/[id]/reorder`) — handles drag-and-drop position updates
15. Board SSE route (`/api/tasks/board/stream`) — server-sent events for live board state
16. Sort-order utilities update — `reindexColumn` imports db/schema internally, takes only `status` param
17. DnD Kanban board — `@dnd-kit/core` + `@dnd-kit/sortable` for drag-and-drop task cards
18. SSE board hook (`src/hooks/use-board-stream.ts`) — live board updates
19. Optimistic updates in Zustand store — immediate UI update, rollback on failure with sonner toast
20. `<Toaster />` added to root layout

## Team Structure

Use a team of agents:
- **exec-components**: Phase 4b Steps 1-7 (log renderer, SSE hook, status badge, cancel button, trigger dialog, log viewer, toolbar)
- **exec-pages**: Phase 4b Steps 8-11 (execution table, row, detail page, list page)
- **terminal-ui**: Phase 4b Steps 12-13 (xterm.js component, terminal page)
- **dnd-realtime**: Phase 5 Steps 14-20 (reorder API, board SSE, DnD board, optimistic updates, sonner)

## Quality Standards

Follow the SAME quality standards from previous phases. Additionally:
- **Type names must be exact**: `AgentCapability` (NOT `Capability`), `ExecutionStatus` enum values from 03-data-model.md
- **No `pending` execution status** — valid values are: `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, `timed_out`
- **STATUS_CONFIG must include `cancelling`** and must NOT include `pending`
- **Capability field names**: use `cap.label` (NOT `cap.name`), `cap.dangerLevel` (NOT `cap.level`)
- **Next.js 16 async params** — ALL dynamic route handlers must use `const { id } = await params;`
- **`reindexColumn(status)`** — takes only status param, imports db/schema internally (no workspaceId filter — single workspace for now)
- **DnD uses fractional indexing** — calculate midpoint between neighbors, reindex column if gap < threshold
- **Optimistic updates** — update Zustand store immediately, revert on API failure, show sonner toast on error
- **Log viewer** — sanitize HTML output with isomorphic-dompurify before rendering ANSI-converted content
- **Web terminal** — xterm.js v6 uses scoped packages (`@xterm/xterm`, `@xterm/addon-fit`, etc.)

## After Implementation

1. `pnpm build` — zero errors
2. `pnpm test` — all tests pass
3. Open execution trigger dialog — select a capability, launch execution
4. Watch live log streaming in the execution detail page
5. Open web terminal for an interactive execution
6. Drag a task card between columns — verify optimistic update + API call
7. Open two browser tabs — verify SSE board updates sync across tabs
```

---

## Prompt 6: Phase 6 — Dashboard + MCP Server + Polish

```
Implement Phase 6 of the Agent Monitor project — Dashboard, MCP Server, and Polish.

## What to Build

Follow the plan file exactly: `plan/phase-6-mcp-dashboard.md`

Reference docs:
- `planning/03-data-model.md` — schema authority
- `planning/02-architecture.md` — MCP architecture
- `planning/04-phases.md` — master checklist (MCP server uses stdio transport, calls API at port 4100)

## Context

Phases 1-5 are complete. The full application is working: agents, tasks, executions, log streaming, terminal, DnD board, SSE updates. This phase adds the dashboard, MCP server for agent-initiated tasks, and polish.

## Deliverables

1. Dashboard service (`src/lib/services/dashboard-service.ts`) — aggregate stats queries
2. Dashboard page (`/dashboard` or `/`) — live stats cards, recent activity feed, execution timeline
3. Dashboard skeleton loading states
4. MCP server (`src/mcp/server.ts`) — tools: `create_task`, `update_task`, `list_tasks`, `create_subtask`, `assign_task`
5. MCP server must resolve agent slugs to UUIDs — add slug-to-UUID lookup via API before sending `assigneeAgentId`
6. MCP build script (`src/mcp/build.ts`) — esbuild bundle to `dist/mcp-server.js`
7. MCP config templates — for Claude Code (`claude_desktop_config.json`), Codex (`config.toml`), etc.
8. Loop prevention (`src/lib/services/loop-prevention.ts`) — max spawn depth, rate limiting, agents cannot self-assign
9. Worker config parsing — read jsonb values with `Number()` conversion (not raw type assertions)
10. Virtual scrolling for execution table — `@tanstack/react-virtual` upgrade
11. Command palette (`src/components/command-palette.tsx`) — shadcn Command component for quick navigation
12. Log rotation cron — pg-boss scheduled job to clean old log files
13. Final polish pass: loading states, error boundaries, empty states across all pages

## Team Structure

Use a team of agents:
- **dashboard**: Steps 1-3 (dashboard service, dashboard page, skeleton states)
- **mcp-server**: Steps 4-7 (MCP server, build script, config templates, slug resolution)
- **backend-polish**: Steps 8-9, 12 (loop prevention, worker config fixes, log rotation)
- **frontend-polish**: Steps 10-11, 13 (virtual scrolling, command palette, loading/error/empty states)

## Quality Standards

Follow the SAME quality standards from previous phases. Additionally:
- **MCP server uses stdio transport** — NOT a WebSocket or HTTP server. It's a standalone Node.js process that communicates via stdin/stdout using `@modelcontextprotocol/sdk`
- **MCP calls the Next.js API at port 4100** — it does NOT import services directly, it uses `fetch` against the REST API
- **Slug-to-UUID resolution** is mandatory — the MCP `assign_task` tool must resolve agent slugs to UUIDs via `GET /api/agents?slug=<slug>` before sending `assigneeAgentId`
- **Loop prevention** — max spawn depth read from `worker_config` table, parsed with `Number()` not type assertion
- **Virtual scrolling** replaces the Phase 4b RSC execution table with a `'use client'` component that uses `@tanstack/react-virtual`
- **Dashboard queries** should be efficient — use SQL aggregations, not fetching all rows and counting in JS
- **Command palette** uses shadcn Command component with keyboard shortcut (Cmd+K / Ctrl+K)

## After Implementation

1. `pnpm build` — zero errors
2. `pnpm test` — all tests pass
3. Dashboard shows live stats (task counts, execution counts, worker status)
4. MCP server builds: `pnpm mcp:build` produces `dist/mcp-server.js`
5. MCP server works with Claude Code: configure it, then verify `create_task` and `list_tasks` tools
6. Command palette opens with Cmd+K, allows quick navigation
7. Execution table handles 100+ rows smoothly with virtual scrolling
8. Full app walkthrough: create agent -> create task -> run execution -> view logs -> see dashboard update
```

---

## Post-Implementation Checklist

After all 6 phases, do a final validation:

```
Final validation of the Agent Monitor project. All 6 phases should be complete.

Run these checks:
1. `pnpm build` — must succeed
2. `pnpm test` — all tests pass
3. Full smoke test: visit every page, trigger every major flow
4. Check for console errors in browser
5. Verify PM2 processes: `pm2 status` shows agent-monitor + worker + terminal-server
6. Verify MCP server: `node dist/mcp-server.js` starts without errors
7. Check database: all tables exist with correct columns
8. Security: no hardcoded secrets, no raw SQL, XSS protection on log viewer
```
