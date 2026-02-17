# Validation: Data Model & Protocol Accuracy

> **Validator**: Task #3 — Cross-reference all plan files against `03-data-model.md` and research docs
> **Date**: 2026-02-17
> **Source of truth**: `/home/ubuntu/projects/agent-monitor/planning/03-data-model.md` (v3.0)
> **Research docs**: `research-bidirectional-agents.md`, `research-claude-headless-protocol.md`, `research-agent-task-management.md`, `research-web-terminal.md`

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 7 |
| WARNING  | 6 |
| INFO     | 3 |

---

## CRITICAL Issues

### C1. Phase 4b: References non-existent `execution_logs` table

**File**: `phase-4b-frontend.md`, line 15 (prerequisites table)
**Quote**:
```
| `src/lib/db/schema.ts` | All tables including `executions`, `execution_logs` | 1 / 4a |
```

**Problem**: The `execution_logs` table does not exist. It was explicitly merged into the `executions` table. The data model comment at line 200 states:
> `// Log fields merged here (execution_logs table removed — 1:1 split was unnecessary).`

Log fields (`logFilePath`, `logByteSize`, `logLineCount`, `logUpdatedAt`) are columns on `executions`, not a separate table.

**Fix**: Remove `execution_logs` from the prerequisites table. The line should read:
```
| `src/lib/db/schema.ts` | All tables including `executions` | 1 / 4a |
```
**Status**: FIXED -- Removed `execution_logs` from phase-4b-frontend.md prerequisites.

---

### C2. Phase 4b: References non-existent `ExecutionLog` type

**File**: `phase-4b-frontend.md`, line 16 (prerequisites table)
**Quote**:
```
| `src/lib/types.ts` | Drizzle inferred types: `Execution`, `ExecutionStatus`, `ExecutionLog` | 1 / 4a |
```

**Problem**: `ExecutionLog` is not defined in `types.ts` (data model lines 362-379). Since `execution_logs` table was merged into `executions`, there is no `ExecutionLog` type. The valid types are: `Agent`, `AgentCapability`, `Task`, `Execution`, `TaskEvent`, `WorkerHeartbeat` (select models) and `NewAgent`, `NewCapability`, `NewTask`, `NewExecution` (insert models).

**Fix**: Remove `ExecutionLog` from the prerequisites. The line should read:
```
| `src/lib/types.ts` | Drizzle inferred types: `Execution`, `ExecutionStatus` | 1 / 4a |
```
**Status**: FIXED -- Removed `ExecutionLog` from phase-4b-frontend.md prerequisites.

---

### C3. Phase 4b: Uses `cap.name` and `cap.level` — wrong field names

**File**: `phase-4b-frontend.md`, lines 543, 568, 600, 664-666, 682
**Quote (line 543)**:
```typescript
import type { Capability, Execution } from '@/lib/types';
```
**Quote (line 664)**:
```typescript
{cap.name}
{(cap.level ?? 0) >= 2 && (
```
**Quote (line 600)**:
```typescript
const isDangerous = (selectedCapability?.level ?? 0) >= 2;
```

**Problem**: Three issues in the execution trigger dialog:

1. **`Capability` type does not exist**. The correct type is `AgentCapability` (data model line 363: `export type AgentCapability = InferSelectModel<typeof schema.agentCapabilities>;`).

2. **`cap.name` does not exist**. The `agentCapabilities` table has no `name` column. The display name field is `label` (data model line 129: `label: text('label').notNull()`).

3. **`cap.level` does not exist**. The danger level field is `dangerLevel` (data model line 142: `dangerLevel: smallint('danger_level').notNull().default(0)`).

**Fix**:
- Import `AgentCapability` instead of `Capability`
- Replace `cap.name` with `cap.label`
- Replace `cap.level` / `selectedCapability?.level` with `cap.dangerLevel` / `selectedCapability?.dangerLevel`
**Status**: FIXED -- Updated all three: import changed to `AgentCapability`, `cap.name` -> `cap.label`, `cap.level` -> `cap.dangerLevel` in phase-4b-frontend.md.

---

### C4. Phase 4a: `capability.workingDir` — field is on `agents`, not `agentCapabilities`

**File**: `phase-4a-backend.md`, line 506
**Quote**:
```typescript
const resolvedCwd = validateWorkingDir(capability.workingDir);
```

**Problem**: The `workingDir` column is on the `agents` table (data model line 97: `workingDir: text('working_dir')`), not on `agentCapabilities`. The `agentCapabilities` table has no `workingDir` field.

**Fix**: Should reference the agent's working directory:
```typescript
const resolvedCwd = validateWorkingDir(agent.workingDir ?? '/tmp');
```
Note: `workingDir` is nullable on agents, so a fallback or validation for null is needed.
**Status**: FIXED -- Changed to `validateWorkingDir(agent.workingDir ?? '/tmp')` in phase-4a-backend.md.

---

### C5. Phase 4b: Status badge includes `pending` — not in `executionStatusEnum`

**File**: `phase-4b-frontend.md`, line 407
**Quote**:
```typescript
const STATUS_CONFIG: Record<ExecutionStatus, ...> = {
  pending:    { label: 'Pending',    variant: 'outline' },
  queued:     { label: 'Queued',     variant: 'secondary' },
  running:    { label: 'Running',    variant: 'default' },
  ...
};
```

**Problem**: `pending` is not a valid `ExecutionStatus` value. The `executionStatusEnum` is defined as (data model lines 57-59):
```typescript
export const executionStatusEnum = pgEnum('execution_status', [
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out',
]);
```

The valid values are: `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, `timed_out`. There is no `pending`.

Since `STATUS_CONFIG` is typed as `Record<ExecutionStatus, ...>`, including `pending` will cause a TypeScript compile error.

**Fix**: Remove the `pending` entry. Also add the missing `cancelling` entry:
```typescript
const STATUS_CONFIG: Record<ExecutionStatus, ...> = {
  queued:      { label: 'Queued',      variant: 'outline' },
  running:     { label: 'Running',     variant: 'default' },
  cancelling:  { label: 'Cancelling',  variant: 'secondary' },
  succeeded:   { label: 'Succeeded',   variant: 'secondary' },
  failed:      { label: 'Failed',      variant: 'destructive' },
  cancelled:   { label: 'Cancelled',   variant: 'outline' },
  timed_out:   { label: 'Timed Out',   variant: 'destructive' },
};
```

Also in `ExecutionCancelButton` (line 470): `status === 'pending'` should be removed:
```typescript
const isCancellable = status === 'running' || status === 'queued';
```
**Status**: FIXED -- Removed `pending` from STATUS_CONFIG, added `cancelling`, and fixed cancel button check in phase-4b-frontend.md.

---

### C6. Phase 6: MCP server sends `assigneeAgentSlug` — API expects `assigneeAgentId` (UUID)

**File**: `phase-6-mcp-dashboard.md`, lines 588, 648, 776, 819
**Quote (line 588, create_task handler)**:
```typescript
if (assignee) body.assigneeAgentSlug = assignee;
```
**Quote (line 648, update_task handler)**:
```typescript
if (assignee) updates.assigneeAgentSlug = assignee;
```
**Quote (line 819, assign_task handler)**:
```typescript
body: JSON.stringify({ assigneeAgentSlug: agentSlug }),
```

**Problem**: The `tasks` table has `assigneeAgentId` as a UUID column (data model lines 172-173):
```typescript
assigneeAgentId: uuid('assignee_agent_id')
  .references(() => agents.id, { onDelete: 'set null' }),
```

The API routes in Phase 3 accept `assigneeAgentId` (a UUID), not `assigneeAgentSlug` (a slug string). The MCP server sends a slug but the REST API expects a UUID. This will silently fail — the task API will ignore the unrecognized `assigneeAgentSlug` field.

**Fix**: Either:
1. (Recommended) The MCP server should resolve the slug to a UUID via `GET /api/agents?slug=<slug>` before calling the task API, then send `assigneeAgentId: resolvedUuid`.
2. Or add slug-to-UUID resolution in the task API route (but this adds coupling).
**Status**: FIXED -- Added slug-to-UUID resolution step in all MCP tool handlers (create_task, update_task, create_subtask, assign_task) in phase-6-mcp-dashboard.md.

---

### C7. Phase 4a: `config.ALLOWED_WORKING_DIRS` type mismatch (string vs string[])

**File**: `phase-4a-backend.md`, line 97
**Quote**:
```typescript
const allowedDirs = config.ALLOWED_WORKING_DIRS; // string[] from env
```

**Problem**: The comment says `string[]` but `config.ALLOWED_WORKING_DIRS` is a `string` (Zod schema in Phase 1 line 103):
```typescript
ALLOWED_WORKING_DIRS: z.string().default('/home/ubuntu/projects:/tmp'),
```

Phase 1 does parse it separately at line 126:
```typescript
export const allowedWorkingDirs = config.ALLOWED_WORKING_DIRS.split(':').filter(Boolean);
```

But the safety module accesses `config.ALLOWED_WORKING_DIRS` directly as a string and calls `.some()` on it, which would fail at runtime since `string.some()` is not a function.

**Fix**: Import and use `allowedWorkingDirs` from config instead of `config.ALLOWED_WORKING_DIRS`:
```typescript
import { allowedWorkingDirs } from '@/lib/config';
// ...
const isAllowed = allowedWorkingDirs.some(
  (allowed) => resolved === allowed || resolved.startsWith(allowed + '/')
);
```
**Status**: FIXED -- Updated import and usage in phase-4a-backend.md safety.ts.

---

## WARNING Issues

### W1. Phase 3: Uses `.includes()` on a Set — should use `.has()`

**File**: `phase-3-tasks.md`, line 192
**Quote**:
```typescript
const allowed = TASK_TRANSITIONS[existing.status];
if (!allowed?.includes(input.status)) {
```

**Problem**: `TASK_TRANSITIONS` values are `ReadonlySet<TaskStatus>` (Phase 1, line 368):
```typescript
export const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set(['in_progress', 'cancelled', 'blocked']),
  ...
```

`Set` does not have an `.includes()` method. The correct method is `.has()`. This will throw a runtime error: `TypeError: allowed.includes is not a function`.

Note: Phase 1 already has the correct helper function `isValidTaskTransition()` (line 402-403):
```typescript
export function isValidTaskTransition(current: TaskStatus, next: TaskStatus): boolean {
  return TASK_TRANSITIONS[current].has(next);
}
```

**Fix**: Either use `.has()` directly or use the helper:
```typescript
if (!allowed?.has(input.status)) {
```
Or better:
```typescript
if (!isValidTaskTransition(existing.status, input.status)) {
```
**Status**: FIXED — Replaced with `isValidTaskTransition()` helper and updated import in phase-3-tasks.md

---

### W2. Phase 5: Reorder route does not use Next.js 16 async params

**File**: `phase-5-realtime.md`, line 43
**Quote**:
```typescript
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: { id: string } }) => {
    const { id } = params;
```

**Problem**: Next.js 16 requires `params` to be accessed asynchronously. The `params` argument is a `Promise` that must be awaited. Phase 4a correctly uses this pattern in other routes, but Phase 5 does not.

**Fix**:
```typescript
export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
```
**Status**: FIXED -- Updated reorder route in phase-5-realtime.md to use `params: Promise<{ id: string }>` with `await params`.

---

### W3. Phase 5: `sonner` toast library used but never installed

**File**: `phase-5-realtime.md`, line 299
**Quote**:
```typescript
import { toast } from 'sonner';
```
Used at line 450:
```typescript
toast.error('Failed to move task. Reverted.');
```

**Problem**: `sonner` is not listed in any `pnpm add` install command across all 7 phase files. The Phase 5 install only adds `@dnd-kit` packages:
```bash
pnpm add @dnd-kit/core@6 @dnd-kit/sortable@8 @dnd-kit/utilities@3
```

**Fix**: Add `sonner` to the Phase 5 install:
```bash
pnpm add @dnd-kit/core@6 @dnd-kit/sortable@8 @dnd-kit/utilities@3 sonner
```
Also need a `<Toaster />` provider component in the app layout.
**Status**: FIXED -- Added `sonner` to Phase 5's pnpm install and added Toaster provider note.

---

### W4. Phase 5: `reindexColumn` function signature mismatch

**File**: `phase-5-realtime.md`, lines 64 vs 130-135
**Quote (line 64, usage)**:
```typescript
await reindexColumn(updated.workspaceId, updated.status);
```
**Quote (lines 130-135, definition)**:
```typescript
export async function reindexColumn(
  db: any,
  tasks: any,
  workspaceId: string,
  status: string,
): Promise<void> {
```

**Problem**: The function is defined with 4 parameters (`db`, `tasks`, `workspaceId`, `status`) but called with only 2 (`workspaceId`, `status`). This will fail at runtime because the first two arguments will be assigned to `db` and `tasks` instead of `workspaceId` and `status`.

**Fix**: Either remove `db` and `tasks` from the function signature (import them directly as other services do), or update the call site:
```typescript
await reindexColumn(db, tasks, updated.workspaceId, updated.status);
```
**Status**: FIXED -- Refactored reindexColumn to accept only `status: string`. Function now imports `db` and `tasks` internally. Removed workspaceId filter. Call site updated to `reindexColumn(updated.status)`.

---

### W5. Phase 4b: `ExecutionCancelButton` checks `status === 'pending'`

**File**: `phase-4b-frontend.md`, line 470
**Quote**:
```typescript
const isCancellable = status === 'running' || status === 'queued' || status === 'pending';
```

**Problem**: `pending` is not a valid `ExecutionStatus` (see C5 above). This check will never be true for `pending`, but the code suggests the developer expected this status to exist. Since `status` is typed as `ExecutionStatus`, TypeScript would flag `'pending'` as an invalid comparison in strict mode.

**Fix**: Remove `status === 'pending'`:
```typescript
const isCancellable = status === 'running' || status === 'queued';
```
**Status**: FIXED -- Removed `pending` check from cancel button in phase-4b-frontend.md.

---

### W6. Phase 4b: Missing `cancelling` in `STATUS_CONFIG`

**File**: `phase-4b-frontend.md`, lines 403-414
**Quote**:
```typescript
const STATUS_CONFIG: Record<ExecutionStatus, ...> = {
  pending:    { ... },
  queued:     { ... },
  running:    { ... },
  succeeded:  { ... },
  failed:     { ... },
  cancelled:  { ... },
  timed_out:  { ... },
};
```

**Problem**: `cancelling` is a valid `ExecutionStatus` but is missing from `STATUS_CONFIG`. Since the type is `Record<ExecutionStatus, ...>`, TypeScript will error because the record is missing the `cancelling` key.

**Fix**: Add `cancelling` entry and remove `pending`:
```typescript
cancelling: { label: 'Cancelling', variant: 'secondary' },
```
**Status**: FIXED -- Added `cancelling` entry and removed `pending` from STATUS_CONFIG in phase-4b-frontend.md.

---

## INFO Issues

### I1. Phase 6: MCP server uses `server.registerTool()` — verify SDK API

**File**: `phase-6-mcp-dashboard.md`, line 545
**Quote**:
```typescript
server.registerTool('create_task', { ... }, async (...) => { ... });
```

**Note**: The `@modelcontextprotocol/sdk` package exports `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`. The `registerTool` method signature shown here (name, config-with-inputSchema, handler) should be verified against the actual SDK version installed. The research doc (`research-agent-task-management.md`) confirms this pattern is correct for the current SDK.

---

### I2. Phase 1: shadcn/ui components assumed but not explicitly installed

**File**: `phase-1-foundation.md`, line 18
**Quote**:
```bash
pnpm add class-variance-authority tailwind-merge clsx lucide-react
```

**Note**: Phase 1 installs the utility dependencies for shadcn/ui but does not include the `npx shadcn-ui@latest init` step or individual component installs (`npx shadcn-ui@latest add button dialog badge ...`). Multiple phases reference shadcn components (`Badge`, `Dialog`, `Button`, `Card`, `Table`, `Sheet`, `Select`, `Input`, `Textarea`, `Separator`, `ScrollArea`, `Toggle`, `Tooltip`). Consider adding explicit shadcn component installation commands.

---

### I3. Phase 6: `priority` input uses string enum, requires parseInt

**File**: `phase-6-mcp-dashboard.md`, lines 560-562, 585
**Quote**:
```typescript
priority: z
  .enum(['1', '2', '3', '4'])
  .default('3')
  .describe('Priority: 1=critical, 2=high, 3=medium, 4=low'),
// ...
priority: parseInt(priority, 10),
```

**Note**: The `priority` field on the `tasks` table is `smallint` (data model line 169: `priority: smallint('priority').notNull().default(3)`). Using `z.enum(['1','2','3','4'])` then `parseInt` works but is unnecessarily convoluted. A `z.coerce.number().int().min(1).max(4).default(3)` would be cleaner and type-safe without the manual parse.

---

## Protocol Verification

### Claude stream-json NDJSON format
- Phase 4a correctly describes the NDJSON protocol with `--input-format stream-json --output-format stream-json` flags.
- Research doc confirms message types: `system`, `user`, `assistant`, `result`, `stream_event`.
- Session resume via `--resume <sessionId>` is correctly documented.
- **Status**: PASS

### Codex app-server JSON-RPC 2.0
- Phase 4a correctly references the JSON-RPC 2.0 protocol via `codex app-server`.
- Research doc confirms methods: `initialize`, `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/resume`.
- **Status**: PASS

### Gemini tmux send-keys/capture-pane
- Phase 4a correctly uses tmux for pseudo-bidirectional communication.
- Research doc confirms no native bidirectional protocol for Gemini CLI.
- Session resume via `--resume latest` is correctly documented.
- **Status**: PASS

### xterm.js v6 scoped packages
- Phase 4b correctly uses `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-search`, `@xterm/addon-webgl`.
- Research doc confirms v6 uses scoped `@xterm/` packages (not legacy `xterm` + `xterm-addon-*`).
- **Status**: PASS

### MCP SDK package imports
- Phase 6 correctly imports from `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js`.
- Research doc confirms these import paths.
- **Status**: PASS

### Socket.io + node-pty terminal server
- Phase 4a correctly uses `socket.io` for WebSocket server and `node-pty` for PTY spawning.
- Terminal server on port 4101 matches `TERMINAL_WS_PORT` config.
- **Status**: PASS

---

## Enum Values Verification

### `taskStatusEnum`
- Data model: `['todo', 'in_progress', 'blocked', 'done', 'cancelled']`
- Phase 3 (task service): Correctly references all 5 values
- Phase 5 (reorder route): `z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled'])` -- CORRECT
- Phase 6 (MCP server): `z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled', 'all'])` -- CORRECT (adds `all` as filter, not DB value)
- **Status**: PASS

### `executionStatusEnum`
- Data model: `['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out']`
- Phase 4b: ~~Includes `pending` (INVALID, see C5). Missing `cancelling` (see W6).~~ FIXED -- `pending` removed, `cancelling` added.
- **Status**: PASS (after fix)

### `interactionModeEnum`
- Data model: `['template', 'prompt']`
- Phase 4a: Correctly uses both values in execution runner
- **Status**: PASS

### `agentKindEnum`
- Data model: `['builtin', 'custom']`
- Phase 2: Correctly references in agent presets
- **Status**: PASS

### `capabilitySourceEnum`
- Data model: `['manual', 'builtin', 'preset', 'scan_help', 'scan_completion', 'scan_fig', 'scan_mcp', 'scan_man', 'llm_generated']`
- Phase 2: Correctly references in discovery pipeline
- **Status**: PASS

---

## Table/Column Names Verification

### `agents` table
- All column references across plan files match data model
- `workingDir` correctly referenced in Phase 2 (agent CRUD)
- `sessionConfig` correctly used as jsonb with `AgentSessionConfig` type
- `mcpEnabled` correctly referenced in Phase 2 and Phase 6
- ~~**Exception**: Phase 4a incorrectly accesses `capability.workingDir` (see C4)~~ FIXED

### `agentCapabilities` table
- `label` field correctly used in Phase 2
- ~~**Exception**: Phase 4b uses non-existent `cap.name` and `cap.level` (see C3)~~ FIXED

### `tasks` table
- `assigneeAgentId` correctly used in Phase 3
- `sortOrder` correctly used in Phase 5
- **Exception**: Phase 6 MCP sends `assigneeAgentSlug` (see C6)

### `executions` table
- All columns correctly referenced in Phase 4a
- Log fields (`logFilePath`, `logByteSize`, `logLineCount`, `logUpdatedAt`) correctly on `executions`
- ~~**Exception**: Prerequisites in Phase 4b reference `execution_logs` (see C1)~~ FIXED

### `taskEvents` table
- Correctly referenced in Phase 3 (audit trail) and Phase 6 (dashboard)

### `taskDependencies` table
- Correctly referenced in Phase 3 (cycle detection, dependency management)

---

## Index Verification

All 9 indexes from the data model are consistently referenced across plan files:
1. `idx_agents_workspace` -- used in agent list queries
2. `idx_capabilities_agent` -- used in capability lookups
3. `idx_tasks_board` -- used in Kanban board query (Phase 3)
4. `idx_tasks_parent` -- used in subtask lookup
5. `idx_executions_queue` -- used in worker job claim (Phase 4a)
6. `idx_executions_task` -- used in task execution history
7. `idx_executions_stale` -- used in stale job detection (Phase 1/4a)
8. `idx_executions_agent_active` -- used in concurrency check
9. `idx_task_events_task` -- used in audit trail queries

**Status**: PASS

---

## Cross-Validator Review (from cross-checker findings)

### C-09 DISPUTED: `execution.mode` column DOES exist

Cross-checker's C-09 claims `execution.mode` doesn't exist on the `executions` table. **This is incorrect.** The data model (`03-data-model.md` line 214) explicitly defines:
```typescript
mode: interactionModeEnum('mode').notNull().default('template'),
```
The `mode` column exists on `executions` and stores the interaction mode copied from the capability at execution creation time. Phase 4a's `execution.mode` references are valid.

### C-10 CONFIRMED: `workspaceId` inconsistency between Phase 3 and Phase 5

The `workspaceId` column exists on the `tasks` table (data model line 162), but Phase 3's task-service never references it in queries or sets it during creation. Phase 5's `reindexColumn` filters by `workspaceId`, creating an inconsistency. Either Phase 3 needs to set/filter `workspaceId`, or Phase 5 should drop the filter for the personal-first MVP.

### W-11 CONFIRMED: `worker_config.value` jsonb cast

Phase 6 dashboard reads `workerConfig.value` (jsonb) and casts directly to number without type checking. Should use `typeof` guard or Zod parse.
