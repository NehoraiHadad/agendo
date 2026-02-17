# Cross-Phase Validation Report

> Generated: 2026-02-17
> Validator: plan-validators / Task #1
> Scope: All 7 plan files + 2 reference docs (02-architecture.md, 04-phases.md)
> Method: Line-by-line cross-reference of imports, types, schemas, packages, file paths, and dependency chains

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 16 |
| WARNING  | 15 |
| INFO     | 6 |

---

## CRITICAL Issues

### C-01: `execution_logs` table referenced but does not exist

**Location**: `phase-4b-frontend.md:15`
**Details**: Prerequisites table says: "All tables including `executions`, `execution_logs`". The architecture doc (02-architecture.md:354) explicitly states: "no separate `execution_logs` table". The data model (03-data-model.md:200) confirms: "execution_logs table removed -- 1:1 split was unnecessary". Log fields are merged directly onto the `executions` table.
**Impact**: Phase 4b implementation would fail trying to import/query a non-existent table.
**Fix**: Remove `execution_logs` from the prerequisites table. Reference `executions` table's log fields (`logFilePath`, `logByteSize`, `logLineCount`) instead.
**Status**: FIXED -- Removed `execution_logs` from phase-4b-frontend.md prerequisites. Now reads: "All tables including `executions` (log fields merged onto executions table)".

---

### C-02: `ExecutionLog` type referenced but does not exist

**Location**: `phase-4b-frontend.md:16`
**Details**: Prerequisites table says types.ts provides `ExecutionLog`. Phase 1's types.ts (phase-1-foundation.md:193-204) defines: `Agent`, `AgentCapability`, `Task`, `Execution`, `TaskDependency`, `TaskEvent`. There is no `ExecutionLog` type.
**Impact**: TypeScript compilation failure in any file importing `ExecutionLog`.
**Fix**: Remove `ExecutionLog` from prerequisites. Log data is accessed via `Execution` type's `logFilePath`, `logByteSize`, `logLineCount` fields.
**Status**: FIXED -- Removed `ExecutionLog` from phase-4b-frontend.md prerequisites. Now reads: "Drizzle inferred types: `Execution`, `ExecutionStatus`".

---

### C-03: `pending` execution status does not exist in enum

**Location**: `phase-4b-frontend.md:470` (execution-cancel-button.tsx)
**Details**: Cancel button checks `status === 'pending'`. The execution status enum (phase-1-foundation.md:380-386) defines: `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, `timed_out`. There is no `pending` status.
**Impact**: The cancel button condition would never match for the intended case. Queued executions become uncancellable from the UI.
**Fix**: Replace `'pending'` with `'queued'` in the cancel button's `isCancellable` check.
**Status**: FIXED -- Removed `pending` from STATUS_CONFIG and cancel button check. Added `cancelling` to STATUS_CONFIG. Cancel check now: `status === 'running' || status === 'queued'`.

---

### C-04: `Capability` type import -- correct name is `AgentCapability`

**Location**: `phase-4b-frontend.md:543` (execution-trigger-dialog.tsx)
**Details**: File imports `type { Capability, Execution } from '@/lib/types'`. Phase 1's types.ts defines `AgentCapability` (line 195) for the select model. There is no exported type named `Capability`. (`NewCapability` exists as the insert model at line 202.)
**Impact**: TypeScript compilation failure.
**Fix**: Change import to `AgentCapability` and update all references in the component.
**Status**: FIXED -- Changed import to `AgentCapability` and updated all `Capability[]` references to `AgentCapability[]` in phase-4b-frontend.md.

---

### C-05: `TASK_TRANSITIONS` returns `Set`, but code uses `.includes()` (Array method)

**Location**: `phase-3-tasks.md:191-192` (task-service.ts `updateTask`)
**Details**: `TASK_TRANSITIONS` is defined in phase-1-foundation.md:368 as `Record<TaskStatus, ReadonlySet<TaskStatus>>`. The values are `Set` objects. Phase 3's task-service.ts calls `allowed?.includes(input.status)`, but `Set` does not have `.includes()` -- it has `.has()`. Phase 1 even provides `isValidTaskTransition()` (line 402) which correctly uses `.has()`.
**Impact**: Runtime error: `TypeError: allowed.includes is not a function`. All task status transitions would crash.
**Fix**: Replace `allowed?.includes(input.status)` with `allowed?.has(input.status)`, or use the provided `isValidTaskTransition(existing.status, input.status)` helper.
**Status**: FIXED — Replaced with `isValidTaskTransition()` helper and updated import in phase-3-tasks.md

---

### C-06: `execution-service.ts` and SSE log stream endpoint missing from Phase 4a

**Location**: `planning/04-phases.md:254-265` vs `phase-4a-backend.md` (entire file)
**Details**: The master checklist (04-phases.md) lists these as Phase 4 deliverables:
- `src/lib/services/execution-service.ts` (createExecution, cancelExecution, getExecutionById, listExecutions)
- API routes: `/api/executions`, `/api/executions/[id]`, `/api/executions/[id]/cancel`, `/api/executions/[id]/logs`, `/api/executions/[id]/logs/stream`, `/api/executions/[id]/message`

Phase 4b lists `execution-service.ts` as a prerequisite ("from Phase 4a"), and the `ExecutionTable` RSC component (4b Step 8, line 1256) imports `listExecutions` from it. But **Phase 4a's plan file contains zero steps for creating execution-service.ts or any execution API routes**. Phase 4a only covers: safety.ts, log-writer.ts, heartbeat.ts, execution-runner.ts, adapters, tmux-manager, and the terminal server.
**Impact**: Phase 4b implementation would fail immediately -- it depends on services and API routes that were never created.
**Fix**: Add explicit steps to Phase 4a for:
1. `src/lib/services/execution-service.ts` (CRUD + cancel)
2. All execution API routes (`/api/executions/*`)
3. SSE log streaming endpoint (`/api/executions/[id]/logs/stream`)
4. Message endpoint (`/api/executions/[id]/message`)
**Status**: FIXED -- Added Section B7 to phase-4a-backend.md with Steps B7a-B7e covering execution-service.ts, all API routes (GET/POST /api/executions, GET /api/executions/[id], POST /api/executions/[id]/cancel, POST /api/executions/[id]/message, GET /api/executions/[id]/logs, GET /api/executions/[id]/logs/stream), and GET /api/workers/status.

---

### C-07: Phase 4a safety.ts uses `config.ALLOWED_WORKING_DIRS` as array but config returns string

**Location**: `phase-4a-backend.md:97-99` (safety.ts `validateWorkingDir`)
**Details**: Code does `const allowedDirs = config.ALLOWED_WORKING_DIRS;` then calls `allowedDirs.some(...)`. But Phase 1's config.ts (phase-1-foundation.md:103) defines `ALLOWED_WORKING_DIRS` as `z.string()` (a colon-separated string like `/home/ubuntu/projects:/tmp`). The parsed array is available as the separately exported `allowedWorkingDirs` (line 126).
**Impact**: Runtime error: `config.ALLOWED_WORKING_DIRS.some is not a function`. All working dir validation fails, blocking every execution.
**Fix**: Import and use `allowedWorkingDirs` (the parsed array) instead of `config.ALLOWED_WORKING_DIRS` (the raw string).
**Status**: FIXED -- Updated safety.ts import to `import { config, allowedWorkingDirs } from '@/lib/config'` and replaced `config.ALLOWED_WORKING_DIRS` usage with `allowedWorkingDirs`.

---

### C-08: Terminal server uses `TERMINAL_JWT_SECRET` but config.ts defines `JWT_SECRET`

**Location**: `phase-4a-backend.md:1702,1816-1820` (auth.ts, server.ts) vs `phase-1-foundation.md:107` (config.ts)
**Details**: Phase 4a's terminal server references `process.env.TERMINAL_JWT_SECRET` and its PM2 config passes `TERMINAL_JWT_SECRET`. But Phase 1's config.ts Zod schema only defines `JWT_SECRET` (line 107). The Phase 4a env var table (line 2119) lists `TERMINAL_JWT_SECRET` as a new var, but Phase 1's config.ts would need updating to include it.
**Impact**: Terminal server would start with `JWT_SECRET = ''` and exit immediately ("TERMINAL_JWT_SECRET is required"). Or if config.ts is used for token generation (line 2101: `config.TERMINAL_JWT_SECRET`), it would fail Zod validation since that key doesn't exist.
**Fix**: Either:
- (a) Add `TERMINAL_JWT_SECRET: z.string().min(16)` to Phase 1's config.ts Zod schema, OR
- (b) Reuse `JWT_SECRET` for both the Next.js app and terminal server (simpler, single secret)
**Status**: FIXED -- Added decision note to Phase 4a's Environment Variables section: `TERMINAL_JWT_SECRET` is a separate secret with `z.string().min(16).optional()` in Phase 1's config.ts. Falls back to `JWT_SECRET` when not set. Terminal server reads directly from `process.env.TERMINAL_JWT_SECRET`.

---

### C-09: Phase 4a `execution-runner.ts` references `execution.mode` -- column doesn't exist

**Location**: `phase-4a-backend.md` (execution-runner.ts)
**Details**: The execution runner switches on `execution.mode` to determine prompt-mode vs interactive-mode behavior. But the `executions` table in 03-data-model.md has no `mode` column. The interaction mode (`prompt` or `interactive`) is a property of the `agent_capabilities` table's `interactionMode` field. To determine mode, the runner needs to join through `execution.capabilityId -> agent_capabilities.interactionMode`.
**Impact**: `execution.mode` would be `undefined`, breaking the mode dispatch logic.
**Fix**: Look up the capability's `interactionMode` via the capability service using `execution.capabilityId`, not a direct `execution.mode` field.

---

### C-10: Phase 5 `reindexColumn` references non-existent `workspaceId` on updated task

**Location**: `phase-5-realtime.md:65-66` (reorder route)
**Details**: After updating task position, the code calls `reindexColumn(updated.workspaceId, updated.status)`. While the data model (03-data-model.md) DOES define `workspaceId` on the tasks table, the Phase 5 reorder function also takes `workspaceId` as a parameter (line 133) and queries `tasks.workspaceId`. However, Phase 3's task-service.ts (which is the primary task service) never references `workspaceId` in any of its queries. This means Phase 5 introduces a `workspaceId` filter that Phase 3 doesn't use, creating inconsistent query behavior.
**Impact**: If Phase 3 doesn't filter by `workspaceId`, reorder and board queries in Phase 5 would return different results than Phase 3 task queries. More critically, the `workspaceId` value must be set on every task, but Phase 3's `createTask` doesn't set it.
**Fix**: Either:
- (a) Phase 3's task-service needs to consistently use `workspaceId` in all queries AND set it on task creation, OR
- (b) Phase 5 should remove the `workspaceId` filter from reindexColumn to match Phase 3's behavior (since the app is personal-first / single-workspace initially)
**Status**: FIXED -- Removed workspaceId filter from reindexColumn; added TODO comment for future multi-workspace support. Function now imports db/tasks internally instead of accepting as params.

---

### C-11: Phase 5 reorder route doesn't `await params` (Next.js 16 requirement)

**Location**: `phase-5-realtime.md` (reorder API route)
**Details**: Next.js 16 requires `params` to be awaited: `const { id } = await params;`. If the Phase 5 reorder route accesses `params.id` synchronously (as was the pattern in Next.js 14), it will fail at runtime.
**Impact**: 500 error on all reorder API calls.
**Fix**: Ensure all dynamic route handlers in Phase 5 use `const { id } = await params;` pattern. (Note: Phase 4b's execution detail page correctly uses this pattern at line 2045.)
**Status**: FIXED -- Updated reorder route to use `params: Promise<{ id: string }>` with `await params`.

---

### C-12: Phase 6 MCP server port mismatch with architecture

**Location**: `phase-6-mcp-dashboard.md` (MCP config template) vs `planning/04-phases.md`
**Details**: The Phase 6 MCP config template uses `http://localhost:4100` for the Agent Monitor API URL, which is correct per the architecture doc (02-architecture.md:22). However, 04-phases.md line mentions "MCP server on port 4000" in the Phase 6 section. This contradicts the architecture. The MCP server itself runs as a stdio process (not on a port), and it calls the Next.js API at port 4100.
**Impact**: If someone follows 04-phases.md's port 4000 reference, MCP server API calls would fail.
**Fix**: Correct 04-phases.md to clarify that the MCP server uses stdio transport and calls the Next.js API at port 4100 (not port 4000).
**Status**: FIXED -- Updated 04-phases.md to reference port 4100 and clarify stdio transport.

---

### C-13: Phase 4b execution-trigger-dialog uses wrong capability field names

**Location**: `phase-4b-frontend.md` (execution-trigger-dialog.tsx)
**Details**: Beyond the type name issue (C-04), the trigger dialog references `cap.name` and `cap.level` to display capability info. Phase 1's `agent_capabilities` schema defines `key` and `label` (not `name`) and `dangerLevel` (not `level`). These are different fields entirely:
- `cap.name` → should be `cap.label` (or `cap.key` for the identifier)
- `cap.level` → should be `cap.dangerLevel`
**Impact**: UI will render `undefined` for capability names and danger indicators in the trigger dialog.
**Fix**: Replace `cap.name` with `cap.label` and `cap.level` with `cap.dangerLevel` throughout execution-trigger-dialog.tsx.
**Status**: FIXED -- Replaced `cap.name` with `cap.label`, `cap.level`/`selectedCapability?.level` with `cap.dangerLevel`/`selectedCapability?.dangerLevel` throughout execution-trigger-dialog.tsx in phase-4b-frontend.md.

---

## WARNING Issues

### W-01: `sonner` toast library used but never installed

**Location**: `phase-5-realtime.md:299` (task-board-store.ts)
**Details**: Phase 5's Zustand store imports `toast` from `sonner` for rollback notifications. `sonner` is not listed in any phase's package install list. Phase 1 installs shadcn/ui but `sonner` is a separate package.
**Fix**: Add `sonner` to Phase 5's new packages list, or use `shadcn add sonner` if using the shadcn toast integration.
**Status**: FIXED -- Added `sonner` to Phase 5's pnpm install command and added Toaster provider note for root layout.

---

### W-02: `Select`, `Input`, `Textarea` shadcn components not in Phase 1 install

**Location**: `phase-3-tasks.md` (task-detail-sheet.tsx, task-quick-add.tsx)
**Details**: Phase 3 uses `Select`, `Input`, and `Textarea` shadcn components. Phase 1's shadcn init (phase-1-foundation.md) installs: `button`, `badge`, `separator`, `sheet`, `scroll-area`, `skeleton`, `tooltip`, `dialog`. `Select`, `Input`, `Textarea` are not included.
**Fix**: Add `npx shadcn@latest add select input textarea` to Phase 1's Step 10 (shadcn components) or Phase 3's prerequisites.
**Status**: FIXED — Added select, input, textarea to Phase 1 shadcn install command

---

### W-03: `Card` shadcn component used in Phase 6 but not installed

**Location**: `phase-6-mcp-dashboard.md` (dashboard-stats.tsx, skeleton-card.tsx)
**Details**: Phase 6 uses `Card`, `CardContent`, `CardHeader` from `@/components/ui/card`. This component is not in Phase 1's shadcn install list.
**Fix**: Add `npx shadcn@latest add card` to Phase 1 or Phase 6 prerequisites.
**Status**: FIXED — Added card to Phase 1 shadcn install command

---

### W-04: `Toggle` shadcn component used in Phase 4b but not installed

**Location**: `phase-4b-frontend.md` (execution-log-toolbar.tsx, line 774)
**Details**: The log toolbar uses `Toggle` from `@/components/ui/toggle`. Not in Phase 1's install list.
**Fix**: Add `npx shadcn@latest add toggle` to Phase 1 or Phase 4b prerequisites.
**Status**: FIXED — Added toggle to Phase 1 shadcn install command

---

### W-05: `Table` shadcn component used in Phase 4b but not installed

**Location**: `phase-4b-frontend.md` (execution-row.tsx, execution-table.tsx)
**Details**: Uses `Table`, `TableBody`, `TableHead`, `TableHeader`, `TableRow`, `TableCell` from `@/components/ui/table`. Not in Phase 1's install list.
**Fix**: Add `npx shadcn@latest add table` to Phase 1 or Phase 4b prerequisites.
**Status**: FIXED — Added table to Phase 1 shadcn install command

---

### W-06: `Command` shadcn component used in Phase 6 but not installed

**Location**: `phase-6-mcp-dashboard.md` (command-palette.tsx)
**Details**: Uses `CommandDialog`, `CommandInput`, `CommandList`, etc. from `@/components/ui/command`. Not in Phase 1's install list.
**Fix**: Add `npx shadcn@latest add command` to Phase 6 prerequisites.
**Status**: FIXED — Added command to Phase 1 shadcn install command

---

### W-07: `Label` shadcn component used in Phase 4b but not installed

**Location**: `phase-4b-frontend.md` (execution-trigger-dialog.tsx)
**Details**: Uses `Label` from `@/components/ui/label`. Not in Phase 1's install list.
**Fix**: Add `npx shadcn@latest add label` to Phase 1 or Phase 2 prerequisites (Phase 2 also uses it for forms).
**Status**: FIXED — Added label to Phase 1 shadcn install command

---

### W-08: Phase 4a uses `socket.io` but architecture mentions `ws`

**Location**: `phase-4a-backend.md` (terminal server) vs `planning/02-architecture.md`
**Details**: The architecture doc references WebSocket connections but Phase 4a implements with `socket.io` (which adds framing, auto-reconnect, rooms). This is a design choice, not a bug, but it means `socket.io-client` is needed on the frontend (Phase 4b correctly includes it). The original architecture's "ws" reference may have been generic.
**Fix**: No code fix needed, but update architecture doc section on terminal server to specify `socket.io` instead of generic "WebSocket".

---

### W-09: Phase 5 duplicates sort-order utilities already in Phase 3

**Location**: `phase-5-realtime.md` (sort-order.ts) vs `phase-3-tasks.md` (task-service.ts)
**Details**: Phase 5 creates a standalone `src/lib/sort-order.ts` with `computeSortOrder`, `needsReindex`, and `reindexColumn`. Phase 3 already defines `calculateMidpoint` and `reindexColumn` inline in `task-service.ts`. These are logically the same operations with different function names.
**Fix**: Extract sort-order utilities into `src/lib/sort-order.ts` during Phase 3 (not Phase 5), and have both Phase 3's task-service and Phase 5's reorder route import from the shared module.
**Status**: FIXED -- Added deduplication note to Phase 5 plan file directing implementers to extract utils to `src/lib/sort-order.ts` during Phase 3. Updated file path from `src/lib/services/sort-order.ts` to `src/lib/sort-order.ts`.

---

### W-10: `date-fns` package used across phases but not explicitly installed

**Location**: `phase-4b-frontend.md` (execution-row.tsx, execution-detail-client.tsx)
**Details**: Multiple components use `formatDistanceToNow` from `date-fns`. This package is not listed in any phase's install step. It may be a transitive dependency but should be explicitly installed.
**Fix**: Add `date-fns` to Phase 1's package.json dependencies.
**Status**: FIXED — Added `date-fns` to Phase 1 core dependencies

---

### W-11: Phase 6 `workerConfig` table usage -- `value` field is `jsonb` but read as number

**Location**: `phase-6-mcp-dashboard.md` (loop-prevention.ts) vs `planning/03-data-model.md:286-288`
**Details**: The `worker_config` table stores `value` as `jsonb`. But `getLoopConfig()` casts values like `configMap.get('max_spawn_depth') as number`. JSONB values would need explicit number extraction, not just a type assertion.
**Fix**: Parse the jsonb value properly: `Number(configMap.get('max_spawn_depth'))` or ensure stored values are plain numbers (which jsonb supports).
**Status**: FIXED -- Replaced raw type assertions with `Number()` conversion: e.g., `Number(configMap.get('max_spawn_depth') ?? DEFAULTS.MAX_SPAWN_DEPTH)`.

---

### W-12: `@types/dompurify` installed in Phase 4b but using `isomorphic-dompurify`

**Location**: `phase-4b-frontend.md` (package list)
**Details**: Phase 4b lists both `isomorphic-dompurify` and `@types/dompurify` as packages. `isomorphic-dompurify` already includes its own type definitions. The `@types/dompurify` package is for the original `dompurify` package and may cause type conflicts.
**Fix**: Remove `@types/dompurify` from the install list. `isomorphic-dompurify` ships its own types.
**Status**: FIXED -- Replaced `pnpm add -D @types/dompurify` with a comment noting isomorphic-dompurify ships its own types.

---

### W-13: 04-phases.md references `generic-adapter.ts` but Phase 4a uses `template-adapter.ts`

**Location**: `planning/04-phases.md` (Phase 4 section) vs `phase-4a-backend.md`
**Details**: The master phases checklist references `generic-adapter.ts` as the fallback adapter file name, but Phase 4a's detailed plan creates it as `template-adapter.ts`. The adapter factory in Phase 4a also imports from `./template-adapter`.
**Fix**: Update 04-phases.md to reference `template-adapter.ts` to match the authoritative Phase 4a plan.
**Status**: FIXED -- Updated 04-phases.md to reference `template-adapter.ts` in both occurrences.

---

### W-14: 04-phases.md references `src/terminal-server/index.ts` but Phase 4a uses `src/terminal/server.ts`

**Location**: `planning/04-phases.md` (Phase 4 section) vs `phase-4a-backend.md`
**Details**: The master phases checklist places the terminal server at `src/terminal-server/index.ts`, but Phase 4a's detailed plan creates it at `src/terminal/server.ts` with auth module at `src/terminal/auth.ts`.
**Fix**: Update 04-phases.md to reference `src/terminal/server.ts` and `src/terminal/auth.ts` to match the authoritative Phase 4a plan.
**Status**: FIXED -- Updated 04-phases.md to reference `src/terminal/server.ts` and `src/terminal/auth.ts`.

---

## INFO Issues

### I-01: Phase 3 typo: `TaskSubtastsListProps` should be `TaskSubtasksListProps`

**Location**: `phase-3-tasks.md`
**Details**: Already noted in the plan file itself as a deliberate typo to fix during implementation. Confirmed: this should be `TaskSubtasksListProps`.
**Status**: FIXED — Replaced all occurrences of `TaskSubtastsListProps` with `TaskSubtasksListProps` in phase-3-tasks.md

---

### I-02: Phase 1 schema vs 03-data-model.md -- workspace columns

**Location**: `phase-1-foundation.md` vs `planning/03-data-model.md`
**Details**: The data model (03-data-model.md) defines `workspaceId` on both `agents` (line 90) and `tasks` (line 162) tables with FK to a workspaces table. However, Phase 1's schema creation step does not include `workspaceId`. This is likely intentional (personal-first, add workspace support later), but it means the schema in Phase 1 diverges from 03-data-model.md.
**Fix**: Either update 03-data-model.md to mark workspace fields as "Phase 7 / future", or add them to Phase 1's schema with a default workspace UUID for the single-user case.

---

### I-03: Architecture mentions `spawn_agent` MCP tool but Phase 6 doesn't implement it

**Location**: `planning/02-architecture.md:51` vs `phase-6-mcp-dashboard.md`
**Details**: The architecture diagram lists `spawn_agent` as an MCP tool. Phase 6's MCP server implements: `create_task`, `update_task`, `list_tasks`, `create_subtask`, `assign_task`. No `spawn_agent` tool.
**Fix**: Either add `spawn_agent` to Phase 6's MCP server, or remove it from the architecture diagram and defer to a future phase.

---

### I-04: `esbuild` used for MCP server build but not in any package install list

**Location**: `phase-6-mcp-dashboard.md` (build.ts)
**Details**: The MCP server build script uses `import { build } from 'esbuild'`. `esbuild` is typically a devDependency. It's likely already present as a transitive dependency of Next.js, but should be explicitly listed.
**Fix**: Add `esbuild` to devDependencies, or use the alternative tsc-based build approach documented in the same step.
**Status**: FIXED — Added `esbuild` to Phase 1 devDependencies

---

### I-05: Phase 4b `execution-table.tsx` is RSC in Phase 4b but becomes client component in Phase 6

**Location**: `phase-4b-frontend.md:1263` vs `phase-6-mcp-dashboard.md:1939`
**Details**: Phase 4b creates `execution-table.tsx` as an RSC (async server component that calls `listExecutions` directly). Phase 6's virtual scrolling upgrade (Step 7) converts it to a `'use client'` component that receives executions as props and uses `@tanstack/react-virtual`. This is a complete rewrite of the component.
**Fix**: No code fix needed -- this is expected progressive enhancement. But Phase 6 should note that this step replaces (not modifies) the Phase 4b RSC version.

---

### I-06: Architecture Phase 4 split coverage check

**Location**: `planning/04-phases.md` Phase 4 section vs `phase-4a-backend.md` + `phase-4b-frontend.md`
**Details**: Coverage analysis of the Phase 4a/4b split:
- **Phase 4a covers**: safety.ts, log-writer.ts, heartbeat.ts, execution-runner.ts, all adapters (claude, codex, gemini, template, factory), tmux-manager.ts, terminal server (auth, server, PM2 config), token API route, **execution-service.ts, all execution API routes, SSE log stream, worker status route** (added via C-06 fix)
- **Phase 4b covers**: log-renderer.ts, SSE hook, all execution UI components, all terminal UI components, execution list/detail pages
- ~~**GAP**: `execution-service.ts` and execution API routes~~ -- FIXED (see C-06)
- ~~**GAP**: Worker status API (`/api/workers/status`)~~ -- FIXED (added as Step B7e)

---

## Dependency Chain Summary

```
Phase 1 (Foundation)
  └── Phase 2 (Discovery) -- depends on: schema, config, api-handler, types
       └── Phase 3 (Tasks) -- depends on: agent-service, state-machines
            └── Phase 4a (Execution Backend) -- depends on: task-service, agent-service
                 └── Phase 4b (Execution Frontend) -- depends on: execution-service [FIXED -- added to 4a]
                      └── Phase 5 (Realtime + DnD) -- depends on: task-board-store, execution-store
                           └── Phase 6 (MCP + Dashboard) -- depends on: all services, SSE infrastructure
```

**Critical path blockers** (all resolved):
1. ~~Phase 4b cannot start until C-06 (missing execution-service.ts) is resolved in Phase 4a~~ -- FIXED
2. ~~Phase 3 task updates will crash until C-05 (.includes -> .has) is fixed~~ -- FIXED
3. ~~Phase 4a safety validation will crash until C-07 (string vs array) is fixed~~ -- FIXED

---

## Package Consistency Matrix

| Package | Installed In | Used In | Status |
|---------|-------------|---------|--------|
| `sonner` | Phase 5 | Phase 5 | FIXED |
| `date-fns` | Phase 1 | Phase 4b | FIXED |
| `@types/dompurify` | ~~Phase 4b~~ | Phase 4b | FIXED (removed -- isomorphic-dompurify has own types) |
| `esbuild` | Phase 1 (devDep) | Phase 6 | FIXED |
| shadcn `select` | Phase 1 | Phase 3, 4b, 6 | FIXED |
| shadcn `input` | Phase 1 | Phase 3, 4b, 6 | FIXED |
| shadcn `textarea` | Phase 1 | Phase 3, 4b | FIXED |
| shadcn `card` | Phase 1 | Phase 6 | FIXED |
| shadcn `toggle` | Phase 1 | Phase 4b | FIXED |
| shadcn `table` | Phase 1 | Phase 4b | FIXED |
| shadcn `command` | Phase 1 | Phase 6 | FIXED |
| shadcn `label` | Phase 1 | Phase 2, 4b, 6 | FIXED |
| `socket.io` | Phase 4a | Phase 4a | OK |
| `socket.io-client` | Phase 4b | Phase 4b | OK |
| `@xterm/*` | Phase 4b | Phase 4b | OK |
| `@dnd-kit/*` | Phase 5 | Phase 5 | OK |
| `@modelcontextprotocol/sdk` | Phase 6 | Phase 6 | OK |
| `@tanstack/react-virtual` | Phase 6 | Phase 6 | OK |
| `zustand` | Phase 3 | Phase 3, 5 | OK |
| `react-hook-form` | Phase 2 | Phase 2, 6 | OK |
| `ansi-to-html` | Phase 4b | Phase 4b | OK |
| `isomorphic-dompurify` | Phase 4b | Phase 4b | OK |

---

## Recommended Fix Priority

1. **C-06** -- Add execution-service.ts + API routes to Phase 4a (blocks entire Phase 4b)
2. **C-05** -- Fix `.includes()` to `.has()` in Phase 3 task-service (blocks all status transitions)
3. **C-07** -- Fix `config.ALLOWED_WORKING_DIRS` to `allowedWorkingDirs` in Phase 4a safety.ts (blocks all executions)
4. **C-08** -- Resolve JWT_SECRET naming in Phase 4a terminal server (blocks terminal connections)
5. **C-09** -- Fix `execution.mode` lookup in Phase 4a runner (blocks execution dispatch)
6. **C-01/C-02** -- Remove phantom `execution_logs` / `ExecutionLog` references in Phase 4b
7. **C-03** -- Replace `'pending'` with `'queued'` in Phase 4b cancel button
8. **C-04** -- Fix `Capability` import to `AgentCapability` in Phase 4b
9. **C-10/C-11** -- Fix workspaceId consistency and async params in Phase 5
10. **C-12** -- Correct port reference in 04-phases.md
11. **C-13** -- Fix capability field names in Phase 4b trigger dialog
12. **C-14** -- Fix `capability.workingDir` to use agent-level field in Phase 4a runner
13. **C-15** -- Fix MCP `assigneeAgentSlug` to `assigneeAgentId` (UUID) in Phase 6
14. **C-16/W-15** -- Fix `reindexColumn` call site to pass all required params in Phase 5
15. **W-01 through W-14** -- Missing packages, components, and file path discrepancies (batch fix)

---

## Cross-Referenced from Data Model Validator (data-checker)

The following issues were identified by the data-checker (VALIDATION-data-model.md) and confirmed valid. Added here for completeness.

### C-14: Phase 4a `capability.workingDir` — field is on `agents` table, not `agentCapabilities`

**Location**: `phase-4a-backend.md` (execution-runner.ts)
**Details**: The execution runner accesses `capability.workingDir` to determine where to run the process. But `workingDir` is a field on the `agents` table (the agent's default working directory), not on `agent_capabilities`. The runner should look up the agent's `workingDir` via the agent record, or accept it as task input context.
**Source**: data-checker C4
**Impact**: Working directory resolution would be `undefined`, causing the execution to run in an unexpected directory or fail safety validation.
**Fix**: Fetch `agent.workingDir` from the agents table using the capability's `agentId` foreign key.
**Status**: FIXED -- Changed `validateWorkingDir(capability.workingDir)` to `validateWorkingDir(agent.workingDir ?? '/tmp')` in execution-runner.ts. The runner already fetches the agent record on the line above.

---

### C-15: Phase 6 MCP `assign_task` sends `assigneeAgentSlug` but API expects `assigneeAgentId` (UUID)

**Location**: `phase-6-mcp-dashboard.md` (MCP server `assign_task` tool)
**Details**: The MCP tool's `assign_task` input schema accepts `assigneeAgentSlug` (a human-readable slug like "claude-code"), but the task service and API route expect `assigneeAgentId` (a UUID). The MCP server would need to resolve the slug to a UUID before calling the API, but no such resolution step exists.
**Source**: data-checker C6
**Impact**: Task assignment via MCP would fail with a foreign key violation or 400 error.
**Fix**: Either (a) add a slug-to-UUID resolution step in the MCP tool handler, or (b) change the MCP input to accept `assigneeAgentId` directly.
**Status**: FIXED -- Added slug-to-UUID resolution step in all MCP tool handlers (create_task, update_task, create_subtask, assign_task). Each handler now calls `GET /api/agents?slug=<slug>` to resolve the UUID before sending to the task API.

---

### C-16: Phase 5 `reindexColumn` signature mismatch — 4 params defined, 2 passed

**Location**: `phase-5-realtime.md` (reorder route calling `reindexColumn`)
**Details**: The `reindexColumn` function is defined with 4 parameters (e.g., `db`, `workspaceId`, `status`, `gapSize`) but the call site in the reorder route only passes 2. This could be a partial application issue or simply a mismatch between definition and usage.
**Source**: data-checker W4 (elevated to CRITICAL here since it would cause a runtime error)
**Impact**: Runtime error or incorrect reindexing behavior.
**Fix**: Align the call site with the function signature, or refactor `reindexColumn` to use the RORO pattern with an options object.
**Status**: FIXED -- Refactored reindexColumn to accept only `status: string` parameter. Function now imports `db` and `tasks` internally (like other services). Removed workspaceId filter (added TODO for multi-workspace). Call site updated to `reindexColumn(updated.status)`.
