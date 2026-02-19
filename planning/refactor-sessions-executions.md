# Refactor Plan: Sessions / Executions Separation

> **Goal**: Clean architectural split — Sessions for AI CLI agents (Claude, Gemini, Codex),
> Executions for fire-and-forget CLI/template commands (git, docker, npm, GitHub CLI).
>
> **Principle**: No messages stored in DB for sessions. CLI tools handle their own
> conversation history. Agendo only streams events to the UI.

---

## Current State (The Problem)

```
POST /api/executions
  ├─ prompt-mode → creates Session + Execution + pg-boss job
  │                Worker receives Execution job → branches to SessionProcess
  └─ template-mode → creates Execution + pg-boss job
                     Worker receives Execution job → runs template adapter

Result: Sessions cannot exist without an Execution "carrier".
        Dual-path if-branches scattered across routes, worker, and UI.
```

## Target State

```
POST /api/sessions   → AI agents (Claude, Gemini, Codex) → /sessions/[id]
POST /api/executions → Template commands (git, docker)   → /executions/[id]

Sessions: own lifecycle, own worker dispatch, own UI
Executions: CLI only, simple queue → run → done
```

---

## Phase 1 — DB Schema

### 1a. Migrations to write

**`0007_sessions_add_fields.sql`** — add missing fields to sessions:
```sql
ALTER TABLE sessions
  ADD COLUMN initial_prompt   text,
  ADD COLUMN total_duration_ms integer,
  ADD COLUMN tmux_session_name text;   -- needed if we want terminal on sessions
```

**`0008_executions_remove_session_fields.sql`** — cleanup (run AFTER Phase 4 is live):
```sql
ALTER TABLE executions
  DROP COLUMN prompt,
  DROP COLUMN prompt_override,
  DROP COLUMN session_ref,
  DROP COLUMN session_id,
  DROP COLUMN total_cost_usd,
  DROP COLUMN total_turns,
  DROP COLUMN total_duration_ms;
```
> ⚠️ Run 0008 last — only after all code paths no longer write to these columns.

### 1b. Sessions table — final shape

| Column | Notes |
|--------|-------|
| `id` | PK |
| `task_id` | FK → tasks |
| `agent_id` | FK → agents |
| `capability_id` | FK → agent_capabilities |
| `status` | active \| awaiting_input \| idle \| ended |
| `pid` | subprocess PID |
| `worker_id` | which worker owns this |
| `session_ref` | external AI session UUID (Claude, Gemini, Codex) |
| `event_seq` | monotonic counter for SSE reconnect |
| `heartbeat_at` | liveness |
| `initial_prompt` | ✨ NEW — the first user prompt / task prompt |
| `started_at` | |
| `last_active_at` | |
| `idle_timeout_sec` | |
| `ended_at` | |
| `total_duration_ms` | ✨ NEW |
| `total_cost_usd` | AI cost |
| `total_turns` | AI turns |
| `log_file_path` | stream source |
| `tmux_session_name` | ✨ NEW — for terminal access |
| `permission_mode` | default \| bypassPermissions \| acceptEdits |
| `allowed_tools` | jsonb string[] |
| `created_at` | |

**No messages table.** CLI tools own conversation history. We only stream.

### 1c. Executions table — final shape (CLI only)

Remove all AI-session columns. Keep:
`id, task_id, agent_id, capability_id, requested_by, status, mode (template only),
args, cli_flags, pid, tmux_session_name, parent_execution_id, started_at, ended_at,
exit_code, error, worker_id, heartbeat_at, log_file_path, log_byte_size,
log_line_count, log_updated_at, retry_count, max_retries, spawn_depth, created_at`

---

## Phase 2 — New Session API

### New routes to create

**`POST /api/sessions`** — create and start a session
```typescript
// Body: { taskId, agentId, capabilityId, initialPrompt, permissionMode?, allowedTools? }
// 1. Validate capability.interactionMode === 'prompt' (return 400 if template)
// 2. Check agent.maxConcurrent against active sessions (not executions)
// 3. INSERT into sessions (status='idle', initial_prompt=...)
// 4. Enqueue pg-boss job: 'run-session' { sessionId }
// 5. Return 201 { data: { id: sessionId } }
```

**`GET /api/sessions`** — list sessions
```typescript
// Query params: taskId?, agentId?, status?, page?, pageSize?
// Returns: { data: Session[], meta: { total, page, pageSize } }
```

**`GET /api/sessions/[id]`** — get session details
```typescript
// Returns full session row + joined agent name + capability label + task title
```

### Existing session routes — keep as-is

| Route | Status |
|-------|--------|
| `GET /api/sessions/[id]/events` | ✅ keep |
| `POST /api/sessions/[id]/cancel` | ✅ keep |
| `POST /api/sessions/[id]/message` | ✅ keep (hot path); rework cold resume (see Phase 3) |
| `POST /api/sessions/[id]/control` | ✅ keep |
| `GET /api/sessions/[id]/memory` | ✅ keep |
| `POST /api/sessions/[id]/memory` | ✅ keep |

---

## Phase 3 — Worker: Independent Session Runner

### New pg-boss job type: `run-session`

Add alongside the existing `execute-capability` queue:

```typescript
// src/worker/index.ts
await boss.work('run-session', { teamSize: 3 }, async (job) => {
  const { sessionId, resumeRef } = job.data;
  await runSession(sessionId, workerId, resumeRef);
});
```

### New module: `src/lib/worker/session-runner.ts`

Extract session logic out of `execution-runner.ts`:

```typescript
export async function runSession(
  sessionId: string,
  workerId: string,
  resumeRef?: string,
): Promise<void> {
  const session = await getSession(sessionId);
  const agent   = await getAgentById(session.agentId);
  const cap     = await getCapabilityById(session.capabilityId);
  const task    = await getTaskById(session.taskId);

  const resolvedCwd = validateWorkingDir(agent.workingDir ?? task.inputContext.workingDir);
  const childEnv    = buildChildEnv(agent.envAllowlist);
  const prompt      = session.initialPrompt ?? interpolateTemplate(cap.promptTemplate, task);
  const adapter     = selectAdapter(agent, cap);

  const sessionProc = new SessionProcess(session, adapter, workerId);
  await sessionProc.start(prompt, resumeRef, resolvedCwd);
  await sessionProc.waitForExit();
}
```

### Cold resume (rework `POST /api/sessions/[id]/message`)

Currently for idle/ended sessions, message route creates a new Execution. After refactor:

```typescript
// Current (bad):
if (status === 'idle' || status === 'ended') {
  const exec = await createExecution(...);   // ← DELETE THIS
  await enqueueExecution(exec.id);           // ← DELETE THIS
}

// New (clean):
if (status === 'idle' || status === 'ended') {
  await db.update(sessions).set({ status: 'active' }).where(eq(sessions.id, id));
  await boss.send('run-session', { sessionId: id, resumeRef: session.sessionRef });
}
```

No new execution record. Session resumes directly via its own queue.

### `execution-runner.ts` — remove session branch

Delete the entire `if (config.USE_SESSION_PROCESS && execution.sessionId)` branch.
`runExecution()` becomes template-only. SessionProcess import is removed.

---

## Phase 4 — Cleanup Execution API Routes

### `POST /api/executions`
- Add guard: `if (capability.interactionMode === 'prompt') return 400`
- Remove: session creation code, `USE_SESSION_PROCESS` check
- Result: template mode only

### `POST /api/executions/[id]/cancel`
- Remove: `if (executionMeta.sessionId)` session branch
- Result: only sets `cancelling` status for CLI executions

### `DELETE /api/executions/[id]/message`
- Entire route removed — sessions handle their own messages via `/api/sessions/[id]/message`

### `GET /api/executions/[id]/logs/stream`
- Remove: `if (execution.sessionId)` branch (session log path, sessions.status polling)
- Result: only streams `executions.logFilePath` for CLI executions

### `GET /api/executions/[id]`
- Remove: `sessionId` join, `sessionRef`, `prompt` from response shape

---

## Phase 5 — Frontend: Run Button Split

**File**: `src/components/executions/execution-trigger-dialog.tsx`

The dialog fetches capabilities. Each capability has `interactionMode: 'template' | 'prompt'`.

On submit, branch by mode:
```typescript
if (selectedCapability.interactionMode === 'prompt') {
  // AI agent → create session
  const res = await fetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ taskId, agentId, capabilityId, initialPrompt: resolvedPrompt }),
  });
  const { data } = await res.json();
  router.push(`/sessions/${data.id}`);
} else {
  // CLI command → create execution (existing behavior)
  const res = await fetch('/api/executions', { ... });
  const { data } = await res.json();
  router.push(`/executions/${data.id}`);
  onExecutionCreated?.(data);
}
```

Consider renaming this component to `RunDialog` since it now handles both types.

---

## Phase 6 — Frontend: Sessions List Page

**New**: `src/app/(dashboard)/sessions/page.tsx`

Mirror the executions list page but for sessions:
- Fetches `GET /api/sessions` with status filter
- Status options: active, awaiting_input, idle, ended
- Each row shows: session ID prefix, agent name, task title, status, duration, cost, created_at
- Links to `/sessions/[id]`

**New**: `src/components/sessions/session-table.tsx` + `session-row.tsx`

---

## Phase 7 — Frontend: Navigation

**File**: `src/components/layout/sidebar.tsx` (or wherever navItems is defined)

```typescript
const navItems = [
  { href: '/',           label: 'Dashboard',  badge: null },
  { href: '/tasks',      label: 'Tasks',       badge: 'todoTasks' },
  { href: '/agents',     label: 'Agents',      badge: null },
  { href: '/sessions',   label: 'Sessions',    badge: 'activeSessions' },   // ← NEW
  { href: '/executions', label: 'Executions',  badge: 'runningExecutions' }, // ← rename badge
];
```

Badge counts:
- `activeSessions` = sessions WHERE status IN ('active', 'awaiting_input')
- `runningExecutions` = executions WHERE status IN ('queued', 'running') — template only

---

## Phase 8 — Frontend: Task Detail Sheet

**File**: `src/components/tasks/task-detail-sheet.tsx` (or `task-execution-history.tsx`)

Currently shows a single execution list + Run button. After refactor, show two sections:

```
┌─ Agent Sessions ────────────────────────────────┐
│  [Session 1 — Claude — 12 turns — 2m ago]       │
│  [Session 2 — Gemini — 3 turns — yesterday]     │
│  [+ New Session]                                 │
└─────────────────────────────────────────────────┘

┌─ CLI Commands ──────────────────────────────────┐
│  [git checkout main — succeeded — 3m ago]       │
│  [npm install — running...]                     │
│  [+ Run Command]                                 │
└─────────────────────────────────────────────────┘
```

Data sources:
- Sessions: `GET /api/sessions?taskId=...`
- Executions: `GET /api/executions?taskId=...` (template-only after refactor)

---

## Phase 9 — Frontend: Execution Detail Cleanup

**File**: `src/app/(dashboard)/executions/[id]/execution-detail-client.tsx`

Remove:
- `useSessionStream` import and usage
- `sessionStatusToExecStatus()` mapper function
- `const sessionStream = useSessionStream(...)` (both calls)
- Chat tab with `SessionChatView` — CLI executions have no chat concept
- `ExecutionCancelButton` session-aware logic

Keep:
- Metadata grid (duration, exit code, mode, started_at, cost if any)
- Logs tab (`ExecutionLogViewer`)
- Terminal tab (for CLI executions that use tmux)

The Chat tab is removed entirely from execution detail. If viewing a historical
execution that had a session, show a link: "View session →" (using the old session_id FK
before it's cleaned up).

---

## Phase 10 — Frontend: Component Cleanup

### Delete
- `src/components/executions/execution-chat-view.tsx` — replaced by SessionChatView
- `src/components/executions/execution-message-input.tsx` — replaced by SessionMessageInput

### Keep (promote to shared)
- `src/components/sessions/session-chat-view.tsx` — canonical chat view
- `src/components/sessions/session-message-input.tsx` — canonical input

### Merge duplicated logic
Both chat views and both message inputs share nearly identical implementations
(ToolCard, AssistantBubble, UserBubble, slash commands, model picker, etc.).
Once ExecutionChatView is deleted, SessionChatView becomes the sole implementation.
No merge needed — just deletion of the duplicate.

### `useExecutionStream` hook
Narrow its purpose: only streams CLI execution logs. Remove any session-status
polling logic that was added for dual-path compatibility.

---

## Phase 11 — FileLogWriter Stats

**File**: `src/lib/worker/log-writer.ts`

Currently `FileLogWriter` writes `logByteSize`/`logLineCount` to the `executions` table.
For sessions, log stats go to the `sessions` table.

After session-runner is extracted, `FileLogWriter` constructed inside `session-runner.ts`
should write to `sessions` table:
```typescript
// session-runner.ts
const logWriter = new FileLogWriter(sessionId, 'sessions'); // pass table target
```

Or: sessions don't need byte/line count stats (the log file is sufficient for streaming).
Could simplify by removing stat tracking from sessions entirely.

---

## Execution Order & Dependencies

```
Phase 1a (DB: sessions add fields)     → no code deps, do first
Phase 2  (new session API routes)      → depends on Phase 1a
Phase 3  (session-runner.ts)           → depends on Phase 2
Phase 4  (cleanup execution routes)    → depends on Phase 3 being live
Phase 5  (run button split)            → depends on Phase 2
Phase 6  (sessions list page)          → depends on Phase 2
Phase 7  (navigation)                  → depends on Phase 6
Phase 8  (task detail sheet)           → depends on Phases 5, 6
Phase 9  (execution detail cleanup)    → depends on Phase 4
Phase 10 (component cleanup)           → depends on Phases 8, 9
Phase 11 (log writer)                  → depends on Phase 3
Phase 1b (DB: remove execution cols)   → LAST — after all code is clean
```

---

## What Does NOT Change

- `session-process.ts` — already clean; SessionRunner calls it directly
- `src/components/sessions/session-chat-view.tsx` — already the canonical view
- `src/components/sessions/tool-approval-card.tsx` — stays
- `GET /api/sessions/[id]/events` SSE — already correct
- `POST /api/sessions/[id]/cancel` — already correct
- `tool-views/` components — shared, no changes
- `model-picker-popover.tsx`, `memory-editor-modal.tsx` — shared, no changes
- Terminal server (`src/terminal/server.ts`) — no changes
- MCP server (`src/lib/mcp/`) — no changes

---

## Risks & Notes

1. **Historical data**: existing executions with `session_id` set. Before removing the FK
   (Phase 1b), freeze these rows or add a "view legacy session" link in the execution
   detail page.

2. **pg-boss `run-session` queue**: new queue type needs to be registered in `worker/index.ts`
   before any sessions are created via the new API. Deploy worker before API.

3. **USE_SESSION_PROCESS env var**: currently guards the session code path. After refactor,
   this flag becomes irrelevant and should be removed from all env configs.

4. **`agent.maxConcurrent`**: currently checked against running *executions*.
   After refactor, check it against active *sessions* instead for AI agents.

5. **Cold resume and pg-boss retries**: when a `run-session` job is retried by pg-boss,
   session-runner must handle the case where session is already `active` (idempotent start).
   The atomic claim in `SessionProcess.start()` already handles this.
