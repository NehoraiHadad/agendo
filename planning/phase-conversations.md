# Phase: Project Conversations — Implementation Plan

> **Goal**: Transform agendo from execution-only into a thinking+doing workspace.
> Sessions can exist without tasks (planning conversations). Ad-hoc tasks are eliminated.

---

## Guiding Principle

```
Today:    Project → Task → Session (always)
Proposed: Project → Session (planning/brainstorm — no task needed)
          Project → Task → Session (execution — same as today)
```

A "conversation" is simply a **session with `taskId = null`**. No new table needed.

---

## Phase 1: Data Model + Backend (no UI changes yet)

### 1.1 DB Migration (0016)

```sql
-- Make taskId nullable (was NOT NULL)
ALTER TABLE sessions ALTER COLUMN task_id DROP NOT NULL;

-- Add projectId (direct link, no need to go through task)
ALTER TABLE sessions ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;

-- Add session kind discriminator
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'execution';
-- Valid values: 'conversation', 'execution'

-- Backfill projectId from existing tasks
UPDATE sessions s
SET project_id = t.project_id
FROM tasks t
WHERE t.id = s.task_id;

-- Index for project-scoped conversation queries
CREATE INDEX idx_sessions_project ON sessions(project_id, kind, created_at DESC)
  WHERE project_id IS NOT NULL;
```

### 1.2 Schema Changes (`src/lib/db/schema.ts`)

```typescript
// sessions table changes:
taskId: uuid('task_id')
  .references(() => tasks.id, { onDelete: 'cascade' }),
  // REMOVED: .notNull()

projectId: uuid('project_id')
  .references(() => projects.id, { onDelete: 'set null' }),

kind: text('kind', { enum: ['conversation', 'execution'] })
  .notNull()
  .default('execution'),
```

Add new index:

```typescript
index('idx_sessions_project').on(table.projectId, table.kind, table.createdAt),
```

### 1.3 Type Changes (`src/lib/types.ts`)

Session type auto-updates from schema (InferSelectModel). `taskId` becomes `string | null`.

### 1.4 Service Layer (`src/lib/services/session-service.ts`)

**`CreateSessionInput`** — make taskId optional, add projectId + kind:

```typescript
export interface CreateSessionInput {
  taskId?: string; // optional now (null for conversations)
  projectId?: string; // required for conversations, derived from task for executions
  kind?: 'conversation' | 'execution'; // default: 'execution'
  agentId: string;
  capabilityId: string;
  // ... rest unchanged
}
```

**`createSession()`** — set projectId from task if not explicit:

```typescript
export async function createSession(input: CreateSessionInput): Promise<Session> {
  let projectId = input.projectId;

  // For execution sessions, derive projectId from task
  if (!projectId && input.taskId) {
    const [task] = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1);
    projectId = task?.projectId ?? undefined;
  }

  const [session] = await db
    .insert(sessions)
    .values({
      taskId: input.taskId ?? null,
      projectId: projectId ?? null,
      kind: input.kind ?? 'execution',
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      // ... rest unchanged
    })
    .returning();
  return session;
}
```

**`listSessionsByProject()`** — change from JOIN-based to direct filter:

```typescript
// Before: INNER JOIN tasks WHERE tasks.project_id = ?
// After:  WHERE sessions.project_id = ?
// This now includes conversations (no task) AND execution sessions for the project
```

**New: `listConversationsByProject()`**:

```typescript
export async function listConversationsByProject(
  projectId: string,
  limit = 20,
): Promise<SessionWithAgent[]> {
  return db
    .select({ ...getTableColumns(sessions), agentName: agents.name })
    .from(sessions)
    .leftJoin(agents, eq(sessions.agentId, agents.id))
    .where(and(eq(sessions.projectId, projectId), eq(sessions.kind, 'conversation')))
    .orderBy(desc(sessions.createdAt))
    .limit(limit);
}
```

### 1.5 Worker Changes

#### `session-runner.ts`

The runner loads task for workingDir, env, and prompt context. When `taskId` is null:

```typescript
// Load task — may be null for conversations
const task = session.taskId
  ? await db.select(...).from(tasks).where(eq(tasks.id, session.taskId)).limit(1).then(r => r[0])
  : null;

// Load project — now directly from session.projectId
const project = session.projectId
  ? await db.select().from(projects).where(eq(projects.id, session.projectId)).limit(1).then(r => r[0])
  : null;

// WorkingDir: task.inputContext.workingDir > project.rootPath > agent.workingDir > /tmp
// (task is null → falls through to project.rootPath — correct behavior)
```

MCP identity object:

```typescript
const identity = {
  sessionId,
  taskId: session.taskId, // may be null — already handled by config-templates
  agentId: session.agentId,
  projectId: session.projectId, // use direct field instead of task?.projectId
};
```

Preamble for conversations (new):

```typescript
if (hasMcp && !resumeRef && prompt) {
  const projectName = project?.name ?? 'unknown';
  if (session.kind === 'conversation') {
    // Planning conversation preamble — no task context
    const preamble =
      `[Agendo Context: project=${projectName}, mode=planning]\n` +
      `Agendo MCP tools are available. You are in a planning conversation.\n` +
      `Use create_task to turn ideas into actionable tasks.\n` +
      `Use list_tasks to see existing tasks in this project.\n` +
      `---\n`;
    prompt = preamble + prompt;
  } else {
    // Existing execution preamble (unchanged)
    ...
  }
}
```

Cold resume: already guarded by `if (resumeRef && session.taskId && task)` — safe.

#### `session-process.ts`

Line 233 already has conditional: `if (this.session.taskId)` — safe. No changes needed.

### 1.6 MCP Server Changes (`src/lib/mcp/server.ts`)

**`get_my_task()`** — graceful when no task:

```typescript
export async function handleGetMyTask(): Promise<unknown> {
  const taskId = process.env.AGENDO_TASK_ID;
  if (!taskId) {
    return {
      message:
        'This is a planning conversation with no assigned task. Use create_task to create tasks.',
    };
  }
  return apiCall(`/api/tasks/${taskId}`);
}
```

**`add_progress_note()`** — already supports explicit taskId arg, no change needed.

### 1.7 API Route: Create Conversation

**Modify `POST /api/projects/[id]/sessions`** — dual-purpose (replaces ad-hoc flow):

```typescript
const quickLaunchSchema = z.object({
  agentId: z.string().uuid(),
  initialPrompt: z.string().optional(),
  view: z.enum(['chat', 'terminal']).optional().default('chat'),
  kind: z.enum(['conversation', 'execution']).optional().default('conversation'),
  // ↑ DEFAULT CHANGES from creating ad-hoc task to creating conversation
});

// When kind === 'conversation':
//   - Do NOT create an ad-hoc task
//   - Create session with projectId directly, taskId = null
//   - Return { sessionId } (no taskId)

// When kind === 'execution':
//   - Keep existing ad-hoc task behavior (backward compat)
//   - Return { sessionId, taskId }
```

### 1.8 Terminal Token Route Fix

`src/app/api/terminal/token/route.ts` uses `INNER JOIN tasks` which will break for taskless sessions.
Change to `LEFT JOIN`:

```typescript
.leftJoin(tasks, eq(tasks.id, sessions.taskId))
```

And derive `cwd` from `session.projectId → project.rootPath` as fallback.

---

## Phase 2: UI — Project Hub Conversations Tab

### 2.1 Project Hub Layout Change

Transform the project hub from a flat page into a tabbed layout:

```
┌─────────────────────────────────────────────┐
│ Project Name                                │
│ /home/ubuntu/projects/agendo                │
├─────────────────────────────────────────────┤
│ [Conversations]  [Sessions]  [Tasks]        │
├─────────────────────────────────────────────┤
│                                             │
│  "Architecture brainstorm" — Claude, 2d ago │
│  "Auth flow planning" — Gemini, yesterday   │
│  "Bug investigation" — Claude, 3h ago       │
│                                             │
│  [+ New Conversation]                       │
│                                             │
└─────────────────────────────────────────────┘
```

Tabs:

- **Conversations** (default) — `kind='conversation'` sessions for this project
- **Sessions** — `kind='execution'` sessions for this project
- **Tasks** — open tasks for this project (compact list, link to full board)

### 2.2 New Conversation Flow

The "Launch Agent" buttons move inside the "New Conversation" action:

1. Click "+ New Conversation" (or agent icon for quick start)
2. QuickLaunchDialog opens with `kind: 'conversation'` default
3. Backend creates session with `taskId = null`, `projectId = project.id`
4. Frontend navigates to `/sessions/{id}?tab=chat`
5. No task is created — the kanban board stays clean

### 2.3 Session Viewer Adaptations

The session detail page (`/sessions/[id]`) needs minor changes:

- If `taskId` is null, don't show "Task: ..." in the info panel
- Show "Project: ..." instead (always shown, derived from session.projectId)
- The "Create Task" action becomes prominent for conversations
- Session title is auto-generated from first message if not set

### 2.4 Session Info Panel

```
┌──────────────────────────┐
│ Session Info              │
│                          │
│ Kind: Conversation       │  ← NEW: shows 'Conversation' or 'Execution'
│ Project: agendo          │  ← Always shown (from session.projectId)
│ Task: —                  │  ← Null for conversations, link for executions
│ Agent: Claude Code       │
│ Model: opus-4-6          │
│ Status: Active           │
│                          │
│ [Create Tasks ▾]         │  ← NEW: prominent for conversations
└──────────────────────────┘
```

### 2.5 Sessions List Page

Add a `kind` filter column and display badge:

- Conversations show a chat-bubble icon
- Executions show a play icon
- Filter dropdown: All / Conversations / Executions

---

## Phase 3: Conversation → Tasks Pipeline (Future)

### 3.1 "Create Tasks" Action

From within a conversation session, a "Create Tasks" button:

- Sends conversation context to the agent
- Agent suggests task breakdowns using MCP `create_task`
- Tasks created with `projectId` from the conversation's project
- Optional: `task.sourceSessionId` field to link back to origin conversation

### 3.2 Context Carry

When launching an execution session from a task that was created from a conversation:

- The execution session's preamble includes a summary of the planning conversation
- Agent has context about WHY this task exists and WHAT was decided

---

## Files to Modify (Phase 1 + 2)

### Database & Schema

- `src/lib/db/schema.ts` — sessions table: nullable taskId, add projectId, add kind
- `drizzle/0016_*.sql` — migration

### Services

- `src/lib/services/session-service.ts` — CreateSessionInput, createSession, listSessionsByProject, new listConversationsByProject

### Worker

- `src/lib/worker/session-runner.ts` — handle null taskId, use session.projectId, conversation preamble
- `src/lib/worker/session-process.ts` — no changes needed (already has guards)

### MCP

- `src/lib/mcp/server.ts` — get_my_task graceful handling
- `src/lib/mcp/config-templates.ts` — no changes needed (already handles null)

### API Routes

- `src/app/api/projects/[id]/sessions/route.ts` — conversation mode (no ad-hoc task)
- `src/app/api/sessions/route.ts` — POST schema: optional taskId
- `src/app/api/sessions/[id]/route.ts` — already uses LEFT JOIN, add projectId to response
- `src/app/api/terminal/token/route.ts` — change INNER JOIN to LEFT JOIN

### UI Components

- `src/app/(dashboard)/projects/[id]/page.tsx` — server: fetch conversations
- `src/components/projects/project-hub-client.tsx` — tabbed layout with conversations
- `src/components/sessions/quick-launch-dialog.tsx` — support kind param
- `src/components/sessions/session-info-panel.tsx` — show project, hide task when null
- `src/components/sessions/session-table.tsx` — kind column/filter/badge
- `src/app/(dashboard)/sessions/page.tsx` — kind filter

### Planning Docs

- `planning/03-data-model.md` — update sessions entity

---

## Migration Safety

- `taskId` becoming nullable is **backward compatible** — existing rows keep their non-null values
- New `projectId` column is nullable — no existing rows break
- New `kind` column defaults to `'execution'` — existing sessions auto-classified correctly
- Backfill query populates `projectId` from task.projectId for existing sessions
- No destructive changes — pure additions

---

## What Does NOT Change

- Kanban board — untouched (only execution sessions create tasks)
- Execution flow — POST /api/executions unchanged
- Session SSE/streaming — unchanged (sessions are sessions regardless of kind)
- Agent adapters — unchanged (they don't care about taskId)
- pg-boss queues — unchanged (run-session works the same)
- Task service — unchanged
- Session chat view — unchanged (it's the same chat UI)

---

## Team Structure for Implementation

Given the scope, split into 3 parallel work streams:

1. **Backend Agent** — DB migration, schema.ts, session-service, session-runner, MCP server, API routes
2. **Frontend Agent** — Project hub tabs, conversation list, session info panel, quick-launch changes, session table kind filter
3. **Test Agent** — Write tests for new service functions, API routes, edge cases (null taskId, conversation creation, etc.)

Backend must complete Phase 1.1-1.7 before Frontend can start Phase 2.
Test agent writes tests first (TDD), then implementation agents make them pass.
