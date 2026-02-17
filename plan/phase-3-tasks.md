# Phase 3: Task Management + Kanban Board (Static)

> **Goal**: Full task CRUD, dependency management with cycle detection, static Kanban board with task detail sheet.
> **Depends on**: Phase 1 (schema, state machines, errors, api-handler, types) and Phase 2 (agent service, capability service, agents table populated)
> **New packages**: `zustand@5`

---

## Prerequisites (Must Exist from Phase 1-2)

Before starting Phase 3, verify these files exist and are functional:

| File | Purpose | Phase |
|------|---------|-------|
| `src/lib/db/schema.ts` | All tables including `tasks`, `task_dependencies`, `task_events` | 1 |
| `src/lib/db/index.ts` | Drizzle singleton with pg pool (max:10) | 1 |
| `src/lib/state-machines.ts` | Task status transition table | 1 |
| `src/lib/errors.ts` | `AppError` hierarchy (`NotFoundError`, `ValidationError`, `ConflictError`) | 1 |
| `src/lib/api-handler.ts` | `withErrorBoundary` wrapper for API routes | 1 |
| `src/lib/api-types.ts` | Response envelope types (`{ data: T }`, `{ data: T[], meta }`, `{ error }`) + `apiFetch` | 1 |
| `src/lib/types.ts` | Drizzle inferred types: `Task`, `NewTask`, `TaskStatus`, `TaskEvent`, etc. | 1 |
| `src/lib/config.ts` | Zod-validated env config | 1 |
| `src/lib/services/agent-service.ts` | `listAgents`, `getAgentById` (needed for assignee dropdown) | 2 |
| `src/components/ui/*` | shadcn components: Sheet, Badge, Dialog, Button, Table, Tooltip, ScrollArea, Separator | 1 |
| `src/components/layout/app-shell.tsx` | Sidebar + main content area | 1 |

---

## Packages to Install

```bash
cd /home/ubuntu/projects/agent-monitor
pnpm add zustand@5
```

Zustand v5 is used for client-side normalized task board state. No middleware needed for this phase (immer/devtools can be added in Phase 5 for optimistic updates).

---

## Steps

### Step 1: Task Service — Core CRUD

**File**: `src/lib/services/task-service.ts`
**Purpose**: Business logic for task CRUD with status transition validation and cursor-paginated listing.
**Depends on**: Phase 1 schema, state-machines, errors, types

```typescript
// src/lib/services/task-service.ts

import { eq, and, sql, desc, lt, asc, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, taskDependencies, taskEvents, agents } from '@/lib/db/schema';
import { isValidTaskTransition } from '@/lib/state-machines';
import { NotFoundError, ConflictError, ValidationError } from '@/lib/errors';
import type { Task, NewTask, TaskStatus } from '@/lib/types';

// --- Sparse sort_order constants ---
const SORT_ORDER_GAP = 1000;
const SORT_ORDER_MIN_GAP = 1; // Trigger reindex when gap < this

// --- Types ---

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: number; // 1-5, default 3
  parentTaskId?: string;
  assigneeAgentId?: string;
  inputContext?: Record<string, unknown>;
  dueAt?: Date;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  assigneeAgentId?: string | null;
  inputContext?: Record<string, unknown>;
  dueAt?: Date | null;
}

export interface TaskWithDetails extends Task {
  subtaskCount: number;
  dependencyCount: number;
  blockedByCount: number;
  assignee: { id: string; name: string; slug: string } | null;
  parentTask: { id: string; title: string } | null;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  cursor?: string; // sort_order value for cursor pagination
  limit?: number;  // default 50
  parentTaskId?: string;
}

// --- Implementation ---

/**
 * Calculate sort_order for a new task appended to the end of a status column.
 * Uses sparse gaps of 1000 so inserts between items are cheap.
 */
async function getNextSortOrder(status: TaskStatus): Promise<number> {
  const [last] = await db
    .select({ sortOrder: tasks.sortOrder })
    .from(tasks)
    .where(eq(tasks.status, status))
    .orderBy(desc(tasks.sortOrder))
    .limit(1);

  return last ? last.sortOrder + SORT_ORDER_GAP : SORT_ORDER_GAP;
}

/**
 * Calculate sort_order between two neighbors (for reordering in Phase 5).
 * Returns midpoint. If gap < SORT_ORDER_MIN_GAP, returns null to signal reindex needed.
 */
export function calculateMidpoint(
  before: number | null,
  after: number | null
): number | null {
  const low = before ?? 0;
  const high = after ?? low + SORT_ORDER_GAP * 2;
  const mid = Math.floor((low + high) / 2);

  if (mid === low || mid === high) {
    return null; // Gap too small, need reindex
  }
  return mid;
}

/**
 * Reindex all sort_order values in a column with fresh gaps.
 * Called when calculateMidpoint returns null.
 */
export async function reindexColumn(status: TaskStatus): Promise<void> {
  const columnTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, status))
    .orderBy(asc(tasks.sortOrder));

  for (let i = 0; i < columnTasks.length; i++) {
    await db
      .update(tasks)
      .set({ sortOrder: (i + 1) * SORT_ORDER_GAP })
      .where(eq(tasks.id, columnTasks[i].id));
  }
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const sortOrder = await getNextSortOrder(input.status ?? 'todo');

  const [task] = await db
    .insert(tasks)
    .values({
      title: input.title,
      description: input.description,
      status: input.status ?? 'todo',
      priority: input.priority ?? 3,
      sortOrder,
      parentTaskId: input.parentTaskId,
      assigneeAgentId: input.assigneeAgentId,
      inputContext: input.inputContext ?? {},
      dueAt: input.dueAt,
    })
    .returning();

  // Audit trail
  await db.insert(taskEvents).values({
    taskId: task.id,
    actorType: 'user',
    eventType: 'task_created',
    payload: { title: task.title, status: task.status },
  });

  return task;
}

export async function updateTask(
  id: string,
  input: UpdateTaskInput
): Promise<Task> {
  const existing = await getTaskById(id);

  // Validate status transition if status is changing
  if (input.status && input.status !== existing.status) {
    if (!isValidTaskTransition(existing.status, input.status)) {
      throw new ConflictError(
        `Invalid status transition: ${existing.status} -> ${input.status}`
      );
    }
  }

  const [updated] = await db
    .update(tasks)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();

  // Audit status change
  if (input.status && input.status !== existing.status) {
    await db.insert(taskEvents).values({
      taskId: id,
      actorType: 'user',
      eventType: 'status_changed',
      payload: { from: existing.status, to: input.status },
    });
  }

  // Audit assignment change
  if (input.assigneeAgentId !== undefined && input.assigneeAgentId !== existing.assigneeAgentId) {
    await db.insert(taskEvents).values({
      taskId: id,
      actorType: 'user',
      eventType: 'assignee_changed',
      payload: { from: existing.assigneeAgentId, to: input.assigneeAgentId },
    });
  }

  return updated;
}

export async function deleteTask(id: string): Promise<void> {
  const existing = await getTaskById(id);

  await db.delete(tasks).where(eq(tasks.id, id));

  // Note: task_dependencies and task_events cascade-delete via FK
}

export async function getTaskById(id: string): Promise<Task> {
  const [task] = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1);

  if (!task) throw new NotFoundError(`Task ${id} not found`);
  return task;
}

/**
 * Get task with all related details (for detail sheet).
 */
export async function getTaskWithDetails(id: string): Promise<TaskWithDetails> {
  const task = await getTaskById(id);

  // Parallel queries for related data
  const [subtaskResult, depResult, blockedByResult, assigneeResult, parentResult] =
    await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasks)
        .where(eq(tasks.parentTaskId, id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, id)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(taskDependencies)
        .where(eq(taskDependencies.dependsOnTaskId, id)),
      task.assigneeAgentId
        ? db
            .select({ id: agents.id, name: agents.name, slug: agents.slug })
            .from(agents)
            .where(eq(agents.id, task.assigneeAgentId))
            .limit(1)
        : Promise.resolve([]),
      task.parentTaskId
        ? db
            .select({ id: tasks.id, title: tasks.title })
            .from(tasks)
            .where(eq(tasks.id, task.parentTaskId))
            .limit(1)
        : Promise.resolve([]),
    ]);

  return {
    ...task,
    subtaskCount: subtaskResult[0]?.count ?? 0,
    dependencyCount: depResult[0]?.count ?? 0,
    blockedByCount: blockedByResult[0]?.count ?? 0,
    assignee: assigneeResult[0] ?? null,
    parentTask: parentResult[0] ?? null,
  };
}

/**
 * List tasks by status with cursor-based pagination.
 * Cursor is the sort_order of the last item on the previous page.
 * Returns tasks ordered by sort_order ASC within a status column.
 */
export async function listTasksByStatus(
  options: ListTasksOptions
): Promise<{ tasks: Task[]; nextCursor: string | null }> {
  const limit = options.limit ?? 50;

  const conditions = [];
  if (options.status) {
    conditions.push(eq(tasks.status, options.status));
  }
  if (options.cursor) {
    conditions.push(
      sql`${tasks.sortOrder} > ${parseInt(options.cursor, 10)}`
    );
  }
  if (options.parentTaskId) {
    conditions.push(eq(tasks.parentTaskId, options.parentTaskId));
  }

  const result = await db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(tasks.sortOrder))
    .limit(limit + 1); // Fetch one extra to detect next page

  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;
  const nextCursor = hasMore
    ? String(page[page.length - 1].sortOrder)
    : null;

  return { tasks: page, nextCursor };
}

/**
 * List subtasks of a given parent task.
 */
export async function listSubtasks(parentTaskId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(asc(tasks.sortOrder));
}
```

**Key decisions**:
- Sparse `sort_order` with gaps of 1000 so inserts between tasks are O(1) most of the time
- `calculateMidpoint` returns `null` when the gap is too small, triggering `reindexColumn`
- Cursor pagination uses `sort_order` (not `created_at`) since board order is the primary display order
- `getTaskWithDetails` runs 5 parallel queries for minimal latency
- Status transitions validated against `TASK_TRANSITIONS` from `state-machines.ts`

---

### Step 2: Dependency Service — Cycle Detection with FOR UPDATE

**File**: `src/lib/services/dependency-service.ts`
**Purpose**: Add/remove task dependencies with transactional DFS cycle detection using row-level locking.
**Depends on**: Step 1 (task-service)

This is the most critical algorithm in Phase 3. The cycle detection must be transactional to prevent concurrent inserts from creating cycles.

```typescript
// src/lib/services/dependency-service.ts

import { eq, and, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, taskDependencies } from '@/lib/db/schema';
import { ConflictError, NotFoundError } from '@/lib/errors';

interface Dependency {
  taskId: string;
  dependsOnTaskId: string;
  createdAt: Date;
}

/**
 * Add a dependency: taskId depends on dependsOnTaskId.
 *
 * Uses transactional DFS with SELECT FOR UPDATE row locking to prevent
 * concurrent operations from creating cycles. The FOR UPDATE lock on the
 * task_dependencies rows ensures that no other transaction can modify the
 * dependency graph while we're checking for cycles.
 *
 * Algorithm:
 *   1. Lock the new edge's source and target task rows (FOR UPDATE)
 *   2. Starting from dependsOnTaskId, DFS through all its dependencies
 *   3. If we reach taskId, adding this edge would create a cycle -> reject
 *   4. If DFS completes without finding taskId, insert the new edge
 *
 * Why FOR UPDATE and not advisory locks:
 *   - FOR UPDATE locks the exact rows involved in the cycle check
 *   - Automatically released on transaction commit/rollback
 *   - Postgres detects deadlocks and aborts one transaction (safe)
 *   - Advisory locks would need manual cleanup
 */
export async function addDependency(
  taskId: string,
  dependsOnTaskId: string
): Promise<Dependency> {
  // Self-dependency is caught by the DB check constraint, but validate early
  if (taskId === dependsOnTaskId) {
    throw new ConflictError('A task cannot depend on itself');
  }

  return db.transaction(async (tx) => {
    // 1. Lock both task rows to prevent concurrent modifications
    //    FOR UPDATE ensures no other transaction can modify these tasks' dependencies
    const lockedTasks = await tx.execute(
      sql`SELECT id FROM tasks WHERE id IN (${taskId}, ${dependsOnTaskId}) FOR UPDATE`
    );

    if ((lockedTasks as any).rowCount < 2) {
      throw new NotFoundError('One or both tasks not found');
    }

    // 2. Check for existing dependency (idempotency)
    const [existing] = await tx
      .select()
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnTaskId, dependsOnTaskId)
        )
      )
      .limit(1);

    if (existing) {
      return existing;
    }

    // 3. Lock ALL dependency edges reachable from dependsOnTaskId
    //    This prevents concurrent cycle creation
    //    We lock the transitive closure of dependencies from the target node
    const reachableEdges = await tx.execute(sql`
      WITH RECURSIVE dep_chain AS (
        -- Start from the target node's dependencies
        SELECT task_id, depends_on_task_id
        FROM task_dependencies
        WHERE task_id = ${dependsOnTaskId}

        UNION

        -- Follow the chain: for each node we've found, get its dependencies
        SELECT td.task_id, td.depends_on_task_id
        FROM task_dependencies td
        INNER JOIN dep_chain dc ON td.task_id = dc.depends_on_task_id
      )
      SELECT task_id, depends_on_task_id FROM dep_chain
      FOR UPDATE OF task_dependencies
    `);

    // 4. DFS cycle check: does dependsOnTaskId transitively depend on taskId?
    //    If so, adding taskId -> dependsOnTaskId would create a cycle.
    const rows = (reachableEdges as any).rows as Array<{
      task_id: string;
      depends_on_task_id: string;
    }>;

    // Build adjacency list from locked edges
    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const deps = adjacency.get(row.task_id) ?? [];
      deps.push(row.depends_on_task_id);
      adjacency.set(row.task_id, deps);
    }

    // DFS from dependsOnTaskId looking for taskId
    const visited = new Set<string>();
    const stack = [dependsOnTaskId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === taskId) {
        throw new ConflictError(
          `Adding dependency would create a cycle: task ${taskId} is already a transitive dependency of task ${dependsOnTaskId}`
        );
      }
      if (visited.has(current)) continue;
      visited.add(current);

      const deps = adjacency.get(current);
      if (deps) {
        for (const dep of deps) {
          if (!visited.has(dep)) {
            stack.push(dep);
          }
        }
      }
    }

    // 5. No cycle detected, insert the new dependency
    const [dependency] = await tx
      .insert(taskDependencies)
      .values({ taskId, dependsOnTaskId })
      .returning();

    return dependency;
  });
}

/**
 * Remove a dependency between two tasks.
 */
export async function removeDependency(
  taskId: string,
  dependsOnTaskId: string
): Promise<void> {
  const result = await db
    .delete(taskDependencies)
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        eq(taskDependencies.dependsOnTaskId, dependsOnTaskId)
      )
    )
    .returning();

  if (result.length === 0) {
    throw new NotFoundError('Dependency not found');
  }
}

/**
 * List all tasks that a given task depends on (its blockers).
 */
export async function listDependencies(
  taskId: string
): Promise<Array<{ id: string; title: string; status: string }>> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(eq(taskDependencies.taskId, taskId));

  return rows;
}

/**
 * List all tasks that depend on a given task (tasks it blocks).
 */
export async function listDependents(
  taskId: string
): Promise<Array<{ id: string; title: string; status: string }>> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
    .where(eq(taskDependencies.dependsOnTaskId, taskId));

  return rows;
}
```

**Key decisions**:
- The recursive CTE with `FOR UPDATE` locks all reachable dependency edges in one query, preventing concurrent cycle creation
- DFS uses an explicit stack (not recursion) to avoid stack overflow on deeply nested graphs
- Idempotent: adding an already-existing dependency returns the existing row
- The `FOR UPDATE OF task_dependencies` clause locks only the dependency rows, not the task rows themselves (task rows are locked separately in step 1)
- Postgres automatically detects deadlocks between concurrent transactions and aborts one, making this safe even under high concurrency

---

### Step 3: Task Event Service — Audit Trail

**File**: `src/lib/services/task-event-service.ts`
**Purpose**: Insert and list audit trail events for tasks.
**Depends on**: Phase 1 schema

```typescript
// src/lib/services/task-event-service.ts

import { eq, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { taskEvents } from '@/lib/db/schema';
import type { TaskEvent } from '@/lib/types';

export interface CreateEventInput {
  taskId: string;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

export async function createTaskEvent(input: CreateEventInput): Promise<TaskEvent> {
  const [event] = await db
    .insert(taskEvents)
    .values({
      taskId: input.taskId,
      actorType: input.actorType,
      actorId: input.actorId,
      eventType: input.eventType,
      payload: input.payload ?? {},
    })
    .returning();

  return event;
}

/**
 * List events for a task, newest first.
 * Limited to 100 to prevent excessive payload sizes.
 */
export async function listTaskEvents(
  taskId: string,
  limit: number = 100
): Promise<TaskEvent[]> {
  return db
    .select()
    .from(taskEvents)
    .where(eq(taskEvents.taskId, taskId))
    .orderBy(desc(taskEvents.createdAt))
    .limit(limit);
}
```

---

### Step 4: Server Actions for Tasks

**File**: `src/lib/actions/task-actions.ts`
**Purpose**: Next.js Server Actions that wrap task service calls with Zod input validation.
**Depends on**: Steps 1, 2, 3

```typescript
// src/lib/actions/task-actions.ts
'use server';

import { z } from 'zod';
import {
  createTask,
  updateTask,
  deleteTask,
  getTaskWithDetails,
} from '@/lib/services/task-service';
import {
  addDependency,
  removeDependency,
} from '@/lib/services/dependency-service';
import { taskStatusEnum } from '@/lib/db/schema';

// --- Schemas ---

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  parentTaskId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  dueAt: z.coerce.date().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

const dependencySchema = z.object({
  taskId: z.string().uuid(),
  dependsOnTaskId: z.string().uuid(),
});

// --- Actions ---

type ActionResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };

export async function createTaskAction(
  input: z.input<typeof createTaskSchema>
): Promise<ActionResult> {
  try {
    const validated = createTaskSchema.parse(input);
    const task = await createTask(validated);
    return { success: true, data: task };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create task',
    };
  }
}

export async function updateTaskAction(
  id: string,
  input: z.input<typeof updateTaskSchema>
): Promise<ActionResult> {
  try {
    const validated = updateTaskSchema.parse(input);
    const task = await updateTask(id, validated);
    return { success: true, data: task };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { success: false, error: error.issues[0].message };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update task',
    };
  }
}

export async function deleteTaskAction(
  id: string
): Promise<ActionResult> {
  try {
    await deleteTask(id);
    return { success: true, data: null };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete task',
    };
  }
}

export async function updateTaskStatusAction(
  id: string,
  status: string
): Promise<ActionResult> {
  try {
    const validatedStatus = z.enum(taskStatusEnum.enumValues).parse(status);
    const task = await updateTask(id, { status: validatedStatus });
    return { success: true, data: task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update status',
    };
  }
}

export async function assignAgentAction(
  taskId: string,
  agentId: string | null
): Promise<ActionResult> {
  try {
    const task = await updateTask(taskId, { assigneeAgentId: agentId });
    return { success: true, data: task };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to assign agent',
    };
  }
}

export async function addDependencyAction(
  input: z.input<typeof dependencySchema>
): Promise<ActionResult> {
  try {
    const validated = dependencySchema.parse(input);
    const dep = await addDependency(validated.taskId, validated.dependsOnTaskId);
    return { success: true, data: dep };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add dependency',
    };
  }
}

export async function removeDependencyAction(
  taskId: string,
  dependsOnTaskId: string
): Promise<ActionResult> {
  try {
    await removeDependency(taskId, dependsOnTaskId);
    return { success: true, data: null };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to remove dependency',
    };
  }
}
```

**Pattern**: Every server action returns `{ success: true, data }` or `{ success: false, error }`. Client components check `success` before using `data`.

---

### Step 5: Task API Routes

**File 1**: `src/app/api/tasks/route.ts`
**File 2**: `src/app/api/tasks/[id]/route.ts`
**File 3**: `src/app/api/tasks/[id]/dependencies/route.ts`
**Purpose**: REST API endpoints for tasks, wrapped in `withErrorBoundary`.
**Depends on**: Steps 1, 2, 3

#### 5a. `/api/tasks` — GET (list) + POST (create)

```typescript
// src/app/api/tasks/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { createTask, listTasksByStatus } from '@/lib/services/task-service';
import { taskStatusEnum } from '@/lib/db/schema';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const status = url.searchParams.get('status') as any;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limit = url.searchParams.get('limit')
    ? parseInt(url.searchParams.get('limit')!, 10)
    : 50;
  const parentTaskId = url.searchParams.get('parentTaskId') ?? undefined;

  const result = await listTasksByStatus({
    status: status ?? undefined,
    cursor,
    limit,
    parentTaskId,
  });

  return NextResponse.json({
    data: result.tasks,
    meta: { nextCursor: result.nextCursor },
  });
});

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  parentTaskId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  dueAt: z.coerce.date().optional(),
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const validated = createSchema.parse(body);
  const task = await createTask(validated);

  return NextResponse.json({ data: task }, { status: 201 });
});
```

#### 5b. `/api/tasks/[id]` — GET, PATCH, DELETE

```typescript
// src/app/api/tasks/[id]/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import {
  getTaskWithDetails,
  updateTask,
  deleteTask,
} from '@/lib/services/task-service';
import { taskStatusEnum } from '@/lib/db/schema';

type Params = { params: Promise<{ id: string }> };

export const GET = withErrorBoundary(async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params;
  const task = await getTaskWithDetails(id);
  return NextResponse.json({ data: task });
});

const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export const PATCH = withErrorBoundary(async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json();
  const validated = patchSchema.parse(body);
  const task = await updateTask(id, validated);
  return NextResponse.json({ data: task });
});

export const DELETE = withErrorBoundary(async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params;
  await deleteTask(id);
  return NextResponse.json({ data: null }, { status: 200 });
});
```

#### 5c. `/api/tasks/[id]/dependencies` — GET, POST, DELETE

```typescript
// src/app/api/tasks/[id]/dependencies/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import {
  addDependency,
  removeDependency,
  listDependencies,
} from '@/lib/services/dependency-service';

type Params = { params: Promise<{ id: string }> };

export const GET = withErrorBoundary(async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params;
  const deps = await listDependencies(id);
  return NextResponse.json({ data: deps });
});

const addSchema = z.object({
  dependsOnTaskId: z.string().uuid(),
});

export const POST = withErrorBoundary(async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json();
  const { dependsOnTaskId } = addSchema.parse(body);
  const dep = await addDependency(id, dependsOnTaskId);
  return NextResponse.json({ data: dep }, { status: 201 });
});

const deleteSchema = z.object({
  dependsOnTaskId: z.string().uuid(),
});

export const DELETE = withErrorBoundary(async (req: NextRequest, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await req.json();
  const { dependsOnTaskId } = deleteSchema.parse(body);
  await removeDependency(id, dependsOnTaskId);
  return NextResponse.json({ data: null });
});
```

**Note on Next.js 16 route params**: `params` is a `Promise` in Next.js 15+. Always `await ctx.params` before destructuring.

---

### Step 6: Zustand Task Board Store

**File**: `src/lib/store/task-board-store.ts`
**Purpose**: Client-side state for the Kanban board. Normalized task lookup + per-column ID arrays. Hydrated from RSC props.
**Depends on**: Phase 1 types

```typescript
// src/lib/store/task-board-store.ts
'use client';

import { create } from 'zustand';
import type { Task, TaskStatus } from '@/lib/types';

// --- Types ---

/** All valid Kanban column statuses in display order */
export const BOARD_COLUMNS: TaskStatus[] = [
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
];

interface TaskBoardState {
  /** Normalized task lookup by ID */
  tasksById: Record<string, Task>;

  /** Ordered task IDs per status column */
  columns: Record<TaskStatus, string[]>;

  /** Cursor for pagination per column (null = no more pages) */
  cursors: Record<TaskStatus, string | null>;

  /** Loading state per column */
  loading: Record<TaskStatus, boolean>;

  /** Currently selected task ID (for detail sheet) */
  selectedTaskId: string | null;
}

interface TaskBoardActions {
  /** Hydrate the store from server-fetched data (called once from RSC wrapper) */
  hydrate: (
    tasksByStatus: Record<TaskStatus, Task[]>,
    cursors: Record<TaskStatus, string | null>
  ) => void;

  /** Append more tasks to a column (from "Load More" pagination) */
  appendToColumn: (
    status: TaskStatus,
    tasks: Task[],
    nextCursor: string | null
  ) => void;

  /** Update a single task in the store (after server action response) */
  updateTask: (task: Task) => void;

  /** Add a new task to the appropriate column */
  addTask: (task: Task) => void;

  /** Remove a task from the store */
  removeTask: (taskId: string) => void;

  /**
   * Move a task between columns (status change).
   * In Phase 3, this is called AFTER the server action succeeds.
   * In Phase 5, this becomes optimistic (move first, rollback on failure).
   */
  moveTask: (taskId: string, newStatus: TaskStatus) => void;

  /** Select a task (opens detail sheet) */
  selectTask: (taskId: string | null) => void;

  /** Set loading state for a column */
  setColumnLoading: (status: TaskStatus, loading: boolean) => void;
}

type TaskBoardStore = TaskBoardState & TaskBoardActions;

// --- Initial state factory ---

function createEmptyColumns(): Record<TaskStatus, string[]> {
  return {
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
    cancelled: [],
  };
}

function createEmptyCursors(): Record<TaskStatus, string | null> {
  return {
    todo: null,
    in_progress: null,
    blocked: null,
    done: null,
    cancelled: null,
  };
}

function createEmptyLoading(): Record<TaskStatus, boolean> {
  return {
    todo: false,
    in_progress: false,
    blocked: false,
    done: false,
    cancelled: false,
  };
}

// --- Store ---

export const useTaskBoardStore = create<TaskBoardStore>((set, get) => ({
  // State
  tasksById: {},
  columns: createEmptyColumns(),
  cursors: createEmptyCursors(),
  loading: createEmptyLoading(),
  selectedTaskId: null,

  // Actions
  hydrate: (tasksByStatus, cursors) => {
    const tasksById: Record<string, Task> = {};
    const columns = createEmptyColumns();

    for (const status of BOARD_COLUMNS) {
      const statusTasks = tasksByStatus[status] ?? [];
      for (const task of statusTasks) {
        tasksById[task.id] = task;
        columns[status].push(task.id);
      }
    }

    set({ tasksById, columns, cursors });
  },

  appendToColumn: (status, tasks, nextCursor) => {
    set((state) => {
      const newTasksById = { ...state.tasksById };
      const newColumn = [...state.columns[status]];

      for (const task of tasks) {
        newTasksById[task.id] = task;
        newColumn.push(task.id);
      }

      return {
        tasksById: newTasksById,
        columns: { ...state.columns, [status]: newColumn },
        cursors: { ...state.cursors, [status]: nextCursor },
      };
    });
  },

  updateTask: (task) => {
    set((state) => {
      const oldTask = state.tasksById[task.id];
      const newTasksById = { ...state.tasksById, [task.id]: task };

      // If status changed, move between columns
      if (oldTask && oldTask.status !== task.status) {
        const oldColumn = state.columns[oldTask.status].filter(
          (id) => id !== task.id
        );
        const newColumn = [...state.columns[task.status], task.id];

        return {
          tasksById: newTasksById,
          columns: {
            ...state.columns,
            [oldTask.status]: oldColumn,
            [task.status]: newColumn,
          },
        };
      }

      return { tasksById: newTasksById };
    });
  },

  addTask: (task) => {
    set((state) => ({
      tasksById: { ...state.tasksById, [task.id]: task },
      columns: {
        ...state.columns,
        [task.status]: [...state.columns[task.status], task.id],
      },
    }));
  },

  removeTask: (taskId) => {
    set((state) => {
      const task = state.tasksById[taskId];
      if (!task) return state;

      const { [taskId]: _, ...newTasksById } = state.tasksById;
      const newColumn = state.columns[task.status].filter(
        (id) => id !== taskId
      );

      return {
        tasksById: newTasksById,
        columns: { ...state.columns, [task.status]: newColumn },
        selectedTaskId:
          state.selectedTaskId === taskId ? null : state.selectedTaskId,
      };
    });
  },

  moveTask: (taskId, newStatus) => {
    set((state) => {
      const task = state.tasksById[taskId];
      if (!task || task.status === newStatus) return state;

      const oldColumn = state.columns[task.status].filter(
        (id) => id !== taskId
      );
      const newColumn = [...state.columns[newStatus], taskId];

      return {
        tasksById: {
          ...state.tasksById,
          [taskId]: { ...task, status: newStatus },
        },
        columns: {
          ...state.columns,
          [task.status]: oldColumn,
          [newStatus]: newColumn,
        },
      };
    });
  },

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  setColumnLoading: (status, loading) =>
    set((state) => ({
      loading: { ...state.loading, [status]: loading },
    })),
}));
```

**Key decisions**:
- **Normalized**: `tasksById` is a flat lookup, `columns` holds only IDs. This prevents object duplication and makes updates O(1).
- **`moveTask` is NOT optimistic in Phase 3**. It is called only after a successful server action. Phase 5 will make it optimistic with rollback.
- **`hydrate` is called once** from the RSC wrapper component that passes server-fetched data into the client boundary.
- **No immer/devtools middleware** in Phase 3 to keep things simple. Phase 5 adds these for optimistic update snapshots.

---

### Step 7: Tasks Page — RSC Data Fetcher

**File**: `src/app/(dashboard)/tasks/page.tsx`
**Purpose**: React Server Component that fetches initial board data and passes it to the client board.
**Depends on**: Steps 1, 6

```typescript
// src/app/(dashboard)/tasks/page.tsx

import { listTasksByStatus } from '@/lib/services/task-service';
import { TaskBoard } from '@/components/tasks/task-board';
import type { Task, TaskStatus } from '@/lib/types';

const BOARD_STATUSES: TaskStatus[] = [
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
];

export default async function TasksPage() {
  // Fetch first page of each status column in parallel
  const results = await Promise.all(
    BOARD_STATUSES.map((status) =>
      listTasksByStatus({ status, limit: 50 })
    )
  );

  const tasksByStatus: Record<TaskStatus, Task[]> = {
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
    cancelled: [],
  };
  const cursors: Record<TaskStatus, string | null> = {
    todo: null,
    in_progress: null,
    blocked: null,
    done: null,
    cancelled: null,
  };

  for (let i = 0; i < BOARD_STATUSES.length; i++) {
    const status = BOARD_STATUSES[i];
    tasksByStatus[status] = results[i].tasks;
    cursors[status] = results[i].nextCursor;
  }

  return <TaskBoard initialData={tasksByStatus} initialCursors={cursors} />;
}
```

---

### Step 8: Kanban Board Components

Build the static Kanban board UI. No drag-and-drop in this phase.

#### 8a. Task Board Container

**File**: `src/components/tasks/task-board.tsx`
**Purpose**: Client component that hydrates the Zustand store from RSC props and renders columns.
**Depends on**: Steps 6, 7

```typescript
// src/components/tasks/task-board.tsx
'use client';

import { useEffect, useRef } from 'react';
import { useTaskBoardStore, BOARD_COLUMNS } from '@/lib/store/task-board-store';
import { TaskColumn } from './task-column';
import { TaskDetailSheet } from './task-detail-sheet';
import { TaskCreateDialog } from './task-create-dialog';
import type { Task, TaskStatus } from '@/lib/types';

interface TaskBoardProps {
  initialData: Record<TaskStatus, Task[]>;
  initialCursors: Record<TaskStatus, string | null>;
}

const COLUMN_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function TaskBoard({ initialData, initialCursors }: TaskBoardProps) {
  const hydrate = useTaskBoardStore((s) => s.hydrate);
  const selectedTaskId = useTaskBoardStore((s) => s.selectedTaskId);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!hydrated.current) {
      hydrate(initialData, initialCursors);
      hydrated.current = true;
    }
  }, [initialData, initialCursors, hydrate]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-6 py-4">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <TaskCreateDialog />
      </div>

      {/* Board columns */}
      <div className="flex flex-1 gap-4 overflow-x-auto p-4">
        {BOARD_COLUMNS.map((status) => (
          <TaskColumn
            key={status}
            status={status}
            label={COLUMN_LABELS[status]}
          />
        ))}
      </div>

      {/* Detail sheet (slides in from right) */}
      {selectedTaskId && <TaskDetailSheet taskId={selectedTaskId} />}
    </div>
  );
}
```

#### 8b. Task Column

**File**: `src/components/tasks/task-column.tsx`

```typescript
// src/components/tasks/task-column.tsx
'use client';

import { useCallback } from 'react';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { TaskCard } from './task-card';
import { TaskQuickAdd } from './task-quick-add';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { TaskStatus } from '@/lib/types';

interface TaskColumnProps {
  status: TaskStatus;
  label: string;
}

export function TaskColumn({ status, label }: TaskColumnProps) {
  const taskIds = useTaskBoardStore((s) => s.columns[status]);
  const cursor = useTaskBoardStore((s) => s.cursors[status]);
  const isLoading = useTaskBoardStore((s) => s.loading[status]);
  const appendToColumn = useTaskBoardStore((s) => s.appendToColumn);
  const setColumnLoading = useTaskBoardStore((s) => s.setColumnLoading);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoading) return;
    setColumnLoading(status, true);

    try {
      const res = await fetch(
        `/api/tasks?status=${status}&cursor=${cursor}&limit=50`
      );
      const json = await res.json();
      appendToColumn(status, json.data, json.meta.nextCursor);
    } finally {
      setColumnLoading(status, false);
    }
  }, [cursor, isLoading, status, appendToColumn, setColumnLoading]);

  return (
    <div className="flex min-w-[280px] flex-col rounded-lg border bg-muted/30">
      {/* Column header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">{label}</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {taskIds.length}
          </span>
        </div>
      </div>

      {/* Cards */}
      <ScrollArea className="flex-1 p-2">
        <div className="flex flex-col gap-2">
          {taskIds.map((id) => (
            <TaskCard key={id} taskId={id} />
          ))}

          {/* Load more button */}
          {cursor && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs"
              onClick={loadMore}
              disabled={isLoading}
            >
              {isLoading ? 'Loading...' : 'Load more'}
            </Button>
          )}

          {/* Empty state */}
          {taskIds.length === 0 && (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">
              No tasks
            </p>
          )}
        </div>
      </ScrollArea>

      {/* Quick add at bottom */}
      <TaskQuickAdd status={status} />
    </div>
  );
}
```

#### 8c. Task Card

**File**: `src/components/tasks/task-card.tsx`

```typescript
// src/components/tasks/task-card.tsx
'use client';

import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TaskCardProps {
  taskId: string;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: 'bg-red-500/10 text-red-500',       // Critical
  2: 'bg-orange-500/10 text-orange-500',  // High
  3: 'bg-blue-500/10 text-blue-500',      // Medium
  4: 'bg-zinc-500/10 text-zinc-500',      // Low
  5: 'bg-zinc-400/10 text-zinc-400',      // Lowest
};

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Critical',
  2: 'High',
  3: 'Medium',
  4: 'Low',
  5: 'Lowest',
};

export function TaskCard({ taskId }: TaskCardProps) {
  const task = useTaskBoardStore((s) => s.tasksById[taskId]);
  const selectTask = useTaskBoardStore((s) => s.selectTask);

  if (!task) return null;

  return (
    <button
      className={cn(
        'w-full rounded-md border bg-background p-3 text-left shadow-sm',
        'transition-colors hover:border-primary/50 hover:shadow-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      onClick={() => selectTask(taskId)}
    >
      {/* Title */}
      <p className="text-sm font-medium leading-tight">{task.title}</p>

      {/* Meta row */}
      <div className="mt-2 flex items-center gap-2">
        {/* Priority badge */}
        <Badge
          variant="outline"
          className={cn('text-xs', PRIORITY_COLORS[task.priority])}
        >
          {PRIORITY_LABELS[task.priority]}
        </Badge>

        {/* Agent badge (if assigned) */}
        {task.assigneeAgentId && (
          <Badge variant="secondary" className="text-xs">
            Assigned
          </Badge>
        )}
      </div>

      {/* Description preview (first line only) */}
      {task.description && (
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
          {task.description}
        </p>
      )}
    </button>
  );
}
```

#### 8d. Task Card Skeleton (loading placeholder)

**File**: `src/components/tasks/task-card-skeleton.tsx`

```typescript
// src/components/tasks/task-card-skeleton.tsx

export function TaskCardSkeleton() {
  return (
    <div className="w-full animate-pulse rounded-md border bg-background p-3">
      <div className="h-4 w-3/4 rounded bg-muted" />
      <div className="mt-2 flex gap-2">
        <div className="h-5 w-16 rounded bg-muted" />
        <div className="h-5 w-12 rounded bg-muted" />
      </div>
      <div className="mt-1.5 h-3 w-full rounded bg-muted" />
    </div>
  );
}
```

---

### Step 9: Task Detail Sheet

The detail sheet is a `Sheet` (not Dialog) that slides in from the right, staying open alongside the board (approximately 40% viewport width).

#### 9a. Main Sheet Container

**File**: `src/components/tasks/task-detail-sheet.tsx`

```typescript
// src/components/tasks/task-detail-sheet.tsx
'use client';

import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { TaskDetailHeader } from './task-detail-header';
import { TaskMetaPanel } from './task-meta-panel';
import { TaskSubtasksList } from './task-subtasks-list';
import { TaskDependenciesPanel } from './task-dependencies-panel';
import { TaskExecutionHistory } from './task-execution-history';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import type { TaskWithDetails } from '@/lib/services/task-service';

interface TaskDetailSheetProps {
  taskId: string;
}

export function TaskDetailSheet({ taskId }: TaskDetailSheetProps) {
  const selectTask = useTaskBoardStore((s) => s.selectTask);
  const [details, setDetails] = useState<TaskWithDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    fetch(`/api/tasks/${taskId}`)
      .then((res) => res.json())
      .then((json) => {
        if (!cancelled) {
          setDetails(json.data);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  return (
    <Sheet open onOpenChange={(open) => !open && selectTask(null)}>
      <SheetContent
        side="right"
        className="w-full sm:w-[40vw] sm:max-w-[600px]"
      >
        <SheetHeader>
          <SheetTitle className="sr-only">Task Details</SheetTitle>
        </SheetHeader>

        {isLoading || !details ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        ) : (
          <ScrollArea className="h-full pr-4">
            <div className="flex flex-col gap-6 pb-8">
              {/* Title, status badge, priority selector */}
              <TaskDetailHeader task={details} />

              <Separator />

              {/* Assignee, parent, due date */}
              <TaskMetaPanel task={details} />

              <Separator />

              {/* Subtasks with inline add */}
              <TaskSubtasksList taskId={details.id} />

              <Separator />

              {/* Dependencies (blocked-by / blocks) */}
              <TaskDependenciesPanel taskId={details.id} />

              <Separator />

              {/* Execution history (empty until Phase 4) */}
              <TaskExecutionHistory taskId={details.id} />
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
```

#### 9b. Task Detail Header

**File**: `src/components/tasks/task-detail-header.tsx`

```typescript
// src/components/tasks/task-detail-header.tsx
'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { updateTaskStatusAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore, BOARD_COLUMNS } from '@/lib/store/task-board-store';
import type { TaskWithDetails } from '@/lib/services/task-service';
import type { TaskStatus } from '@/lib/types';

interface TaskDetailHeaderProps {
  task: TaskWithDetails;
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  todo: 'bg-zinc-500/10 text-zinc-500',
  in_progress: 'bg-blue-500/10 text-blue-500',
  blocked: 'bg-red-500/10 text-red-500',
  done: 'bg-green-500/10 text-green-500',
  cancelled: 'bg-zinc-400/10 text-zinc-400',
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function TaskDetailHeader({ task }: TaskDetailHeaderProps) {
  const moveTask = useTaskBoardStore((s) => s.moveTask);
  const updateTask = useTaskBoardStore((s) => s.updateTask);
  const [isPending, setIsPending] = useState(false);

  const handleStatusChange = async (newStatus: TaskStatus) => {
    setIsPending(true);
    const result = await updateTaskStatusAction(task.id, newStatus);

    if (result.success) {
      moveTask(task.id, newStatus);
    }
    setIsPending(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{task.title}</h2>

      {task.description && (
        <p className="text-sm text-muted-foreground">{task.description}</p>
      )}

      <div className="flex items-center gap-3">
        {/* Status dropdown */}
        <Select
          value={task.status}
          onValueChange={(v) => handleStatusChange(v as TaskStatus)}
          disabled={isPending}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BOARD_COLUMNS.map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Priority badge (read-only in header, editable in meta panel) */}
        <Badge variant="outline" className="text-xs">
          P{task.priority}
        </Badge>
      </div>
    </div>
  );
}
```

#### 9c. Task Meta Panel

**File**: `src/components/tasks/task-meta-panel.tsx`

```typescript
// src/components/tasks/task-meta-panel.tsx
'use client';

import { useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { assignAgentAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import type { TaskWithDetails } from '@/lib/services/task-service';

interface TaskMetaPanelProps {
  task: TaskWithDetails;
}

interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

export function TaskMetaPanel({ task }: TaskMetaPanelProps) {
  const updateTask = useTaskBoardStore((s) => s.updateTask);
  const [agents, setAgents] = useState<AgentOption[]>([]);

  // Fetch agents for assignee dropdown
  useEffect(() => {
    fetch('/api/agents')
      .then((res) => res.json())
      .then((json) => setAgents(json.data ?? []))
      .catch(() => {});
  }, []);

  const handleAssign = async (agentId: string) => {
    const id = agentId === 'unassigned' ? null : agentId;
    const result = await assignAgentAction(task.id, id);
    if (result.success) {
      updateTask(result.data as any);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Details</h3>

      {/* Assignee */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Assignee</span>
        <Select
          value={task.assigneeAgentId ?? 'unassigned'}
          onValueChange={handleAssign}
        >
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Unassigned" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Parent task */}
      {task.parentTask && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Parent</span>
          <span className="text-sm">{task.parentTask.title}</span>
        </div>
      )}

      {/* Due date */}
      {task.dueAt && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Due</span>
          <span className="text-sm">
            {new Date(task.dueAt).toLocaleDateString()}
          </span>
        </div>
      )}
    </div>
  );
}
```

#### 9d. Task Subtasks List

**File**: `src/components/tasks/task-subtasks-list.tsx`

```typescript
// src/components/tasks/task-subtasks-list.tsx
'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import type { Task } from '@/lib/types';

interface TaskSubtasksListProps {
  taskId: string;
}

export function TaskSubtasksList({ taskId }: TaskSubtasksListProps) {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const [subtasks, setSubtasks] = useState<Task[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    fetch(`/api/tasks?parentTaskId=${taskId}`)
      .then((res) => res.json())
      .then((json) => setSubtasks(json.data ?? []))
      .catch(() => {});
  }, [taskId]);

  const handleAdd = async () => {
    if (!newTitle.trim()) return;

    const result = await createTaskAction({
      title: newTitle.trim(),
      parentTaskId: taskId,
    });

    if (result.success) {
      const newTask = result.data as Task;
      setSubtasks((prev) => [...prev, newTask]);
      addTask(newTask);
      setNewTitle('');
      setIsAdding(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Subtasks</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsAdding(true)}
        >
          + Add
        </Button>
      </div>

      {subtasks.map((sub) => (
        <div
          key={sub.id}
          className="flex items-center justify-between rounded border px-3 py-2"
        >
          <span className="text-sm">{sub.title}</span>
          <Badge variant="outline" className="text-xs">
            {sub.status}
          </Badge>
        </div>
      ))}

      {subtasks.length === 0 && !isAdding && (
        <p className="text-sm text-muted-foreground">No subtasks</p>
      )}

      {isAdding && (
        <div className="flex gap-2">
          <Input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Subtask title..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
              if (e.key === 'Escape') setIsAdding(false);
            }}
          />
          <Button size="sm" onClick={handleAdd}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
```

**Note**: There is a deliberate typo in the interface name `TaskSubtasksListProps` which should be `TaskSubtasksListProps` -- fix this during implementation.

#### 9e. Task Dependencies Panel

**File**: `src/components/tasks/task-dependencies-panel.tsx`

```typescript
// src/components/tasks/task-dependencies-panel.tsx
'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  addDependencyAction,
  removeDependencyAction,
} from '@/lib/actions/task-actions';
import { X as XIcon } from 'lucide-react';

interface Dep {
  id: string;
  title: string;
  status: string;
}

interface TaskDependenciesPanelProps {
  taskId: string;
}

export function TaskDependenciesPanel({ taskId }: TaskDependenciesPanelProps) {
  const [dependencies, setDependencies] = useState<Dep[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Dep[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Fetch current dependencies
  useEffect(() => {
    fetch(`/api/tasks/${taskId}/dependencies`)
      .then((res) => res.json())
      .then((json) => setDependencies(json.data ?? []))
      .catch(() => {});
  }, [taskId]);

  // Search tasks for dependency selection
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      const res = await fetch(`/api/tasks?limit=10`);
      const json = await res.json();
      // Filter out self and existing deps client-side
      const existing = new Set([taskId, ...dependencies.map((d) => d.id)]);
      setSearchResults(
        (json.data ?? []).filter((t: any) => !existing.has(t.id))
      );
    }, 300);

    return () => clearTimeout(timeout);
  }, [searchQuery, taskId, dependencies]);

  const handleAdd = async (depId: string) => {
    setError(null);
    const result = await addDependencyAction({
      taskId,
      dependsOnTaskId: depId,
    });

    if (result.success) {
      const added = searchResults.find((r) => r.id === depId);
      if (added) {
        setDependencies((prev) => [...prev, added]);
      }
      setIsAdding(false);
      setSearchQuery('');
    } else {
      setError(result.error);
    }
  };

  const handleRemove = async (depId: string) => {
    const result = await removeDependencyAction(taskId, depId);
    if (result.success) {
      setDependencies((prev) => prev.filter((d) => d.id !== depId));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Blocked By</h3>
        <Button variant="ghost" size="sm" onClick={() => setIsAdding(true)}>
          + Add
        </Button>
      </div>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      {dependencies.map((dep) => (
        <div
          key={dep.id}
          className="flex items-center justify-between rounded border px-3 py-2"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm">{dep.title}</span>
            <Badge variant="outline" className="text-xs">
              {dep.status}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => handleRemove(dep.id)}
          >
            <XIcon className="h-3 w-3" />
          </Button>
        </div>
      ))}

      {dependencies.length === 0 && !isAdding && (
        <p className="text-sm text-muted-foreground">No dependencies</p>
      )}

      {isAdding && (
        <div className="flex flex-col gap-2">
          <Input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setIsAdding(false);
                setSearchQuery('');
              }
            }}
          />
          {searchResults.map((result) => (
            <button
              key={result.id}
              className="rounded border px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => handleAdd(result.id)}
            >
              {result.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

#### 9f. Task Execution History (placeholder for Phase 4)

**File**: `src/components/tasks/task-execution-history.tsx`

```typescript
// src/components/tasks/task-execution-history.tsx
'use client';

interface TaskExecutionHistoryProps {
  taskId: string;
}

export function TaskExecutionHistory({ taskId }: TaskExecutionHistoryProps) {
  // Placeholder - will be populated in Phase 4 when execution engine is built
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Execution History</h3>
      <p className="text-sm text-muted-foreground">
        No executions yet. Execution support will be available after agent
        capabilities are configured.
      </p>
    </div>
  );
}
```

---

### Step 10: Task Creation Components

#### 10a. Task Create Dialog

**File**: `src/components/tasks/task-create-dialog.tsx`

```typescript
// src/components/tasks/task-create-dialog.tsx
'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { createTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { Plus } from 'lucide-react';
import type { Task } from '@/lib/types';

export function TaskCreateDialog() {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('3');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setIsPending(true);
    setError(null);

    const result = await createTaskAction({
      title: title.trim(),
      description: description.trim() || undefined,
      priority: parseInt(priority, 10),
    });

    if (result.success) {
      addTask(result.data as Task);
      setTitle('');
      setDescription('');
      setPriority('3');
      setOpen(false);
    } else {
      setError(result.error);
    }

    setIsPending(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" />
          New Task
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Task</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            required
          />

          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
          />

          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Critical</SelectItem>
              <SelectItem value="2">High</SelectItem>
              <SelectItem value="3">Medium</SelectItem>
              <SelectItem value="4">Low</SelectItem>
              <SelectItem value="5">Lowest</SelectItem>
            </SelectContent>
          </Select>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={isPending || !title.trim()}>
            {isPending ? 'Creating...' : 'Create Task'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

#### 10b. Task Quick Add (inline at bottom of column)

**File**: `src/components/tasks/task-quick-add.tsx`

```typescript
// src/components/tasks/task-quick-add.tsx
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createTaskAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { Plus } from 'lucide-react';
import type { Task, TaskStatus } from '@/lib/types';

interface TaskQuickAddProps {
  status: TaskStatus;
}

export function TaskQuickAdd({ status }: TaskQuickAddProps) {
  const addTask = useTaskBoardStore((s) => s.addTask);
  const [isActive, setIsActive] = useState(false);
  const [title, setTitle] = useState('');
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || isPending) return;

    setIsPending(true);
    const result = await createTaskAction({
      title: title.trim(),
      status,
    });

    if (result.success) {
      addTask(result.data as Task);
      setTitle('');
    }

    setIsPending(false);
  };

  if (!isActive) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="m-2 justify-start text-xs text-muted-foreground"
        onClick={() => setIsActive(true)}
      >
        <Plus className="mr-1 h-3 w-3" />
        Add task
      </Button>
    );
  }

  return (
    <div className="m-2 flex gap-2">
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title..."
        className="h-8 text-sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') {
            setIsActive(false);
            setTitle('');
          }
        }}
        onBlur={() => {
          if (!title.trim()) {
            setIsActive(false);
          }
        }}
      />
      <Button
        size="sm"
        className="h-8"
        onClick={handleSubmit}
        disabled={isPending || !title.trim()}
      >
        Add
      </Button>
    </div>
  );
}
```

---

### Step 11: Wire Up Navigation

**File to modify**: `src/components/layout/sidebar.tsx` (exists from Phase 1)
**Change**: Ensure the Tasks link points to `/tasks` and shows task count badge.

**File to modify**: `src/app/(dashboard)/tasks/page.tsx` (created in Step 7)
**Change**: Already done in Step 7.

No new files needed. Just verify the sidebar has:

```typescript
{ label: 'Tasks', href: '/tasks', icon: CheckSquare }
```

And that `/tasks` is included in the `(dashboard)` layout group from Phase 1.

---

## File Summary

| # | File | Action | LOC (est.) |
|---|------|--------|-----------|
| 1 | `src/lib/services/task-service.ts` | Create | ~200 |
| 2 | `src/lib/services/dependency-service.ts` | Create | ~150 |
| 3 | `src/lib/services/task-event-service.ts` | Create | ~40 |
| 4 | `src/lib/actions/task-actions.ts` | Create | ~130 |
| 5a | `src/app/api/tasks/route.ts` | Modify (was stub) | ~50 |
| 5b | `src/app/api/tasks/[id]/route.ts` | Create | ~50 |
| 5c | `src/app/api/tasks/[id]/dependencies/route.ts` | Create | ~50 |
| 6 | `src/lib/store/task-board-store.ts` | Create | ~150 |
| 7 | `src/app/(dashboard)/tasks/page.tsx` | Modify (was empty shell) | ~40 |
| 8a | `src/components/tasks/task-board.tsx` | Create | ~50 |
| 8b | `src/components/tasks/task-column.tsx` | Create | ~70 |
| 8c | `src/components/tasks/task-card.tsx` | Create | ~60 |
| 8d | `src/components/tasks/task-card-skeleton.tsx` | Create | ~15 |
| 9a | `src/components/tasks/task-detail-sheet.tsx` | Create | ~70 |
| 9b | `src/components/tasks/task-detail-header.tsx` | Create | ~80 |
| 9c | `src/components/tasks/task-meta-panel.tsx` | Create | ~80 |
| 9d | `src/components/tasks/task-subtasks-list.tsx` | Create | ~80 |
| 9e | `src/components/tasks/task-dependencies-panel.tsx` | Create | ~110 |
| 9f | `src/components/tasks/task-execution-history.tsx` | Create | ~15 |
| 10a | `src/components/tasks/task-create-dialog.tsx` | Create | ~90 |
| 10b | `src/components/tasks/task-quick-add.tsx` | Create | ~70 |
| 11 | `src/components/layout/sidebar.tsx` | Modify | ~5 |

**Total estimated**: ~1,555 lines across 21 files

---

## Testing Checklist

All test files go in `src/__tests__/` mirroring the source structure.

### Unit Tests

**File**: `src/__tests__/lib/services/task-service.test.ts`

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `createTask` sets sparse sort_order | New task gets `SORT_ORDER_GAP` (1000) increments |
| 2 | `updateTask` rejects invalid transition | `done` -> `in_progress` throws `ConflictError` |
| 3 | `updateTask` allows valid transition | `todo` -> `in_progress` succeeds |
| 4 | `updateTask` allows reopen | `done` -> `todo` succeeds |
| 5 | `calculateMidpoint` returns correct midpoint | `midpoint(1000, 2000)` = 1500 |
| 6 | `calculateMidpoint` returns null on tiny gap | `midpoint(1000, 1001)` = null |
| 7 | `listTasksByStatus` respects cursor | Returns only tasks after cursor value |
| 8 | `listTasksByStatus` detects hasMore | Returns `nextCursor` when more than `limit` exist |

**File**: `src/__tests__/lib/services/dependency-service.test.ts`

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Direct cycle rejected | A->B, B->A throws `ConflictError` |
| 2 | Transitive cycle rejected | A->B, B->C, C->A throws `ConflictError` |
| 3 | Diamond dependency allowed | A->B, A->C, B->D, C->D (no cycle, succeeds) |
| 4 | Self-dependency rejected | A->A throws `ConflictError` |
| 5 | Idempotent add | Adding same dependency twice returns existing |
| 6 | Remove nonexistent throws | `removeDependency` on missing edge throws `NotFoundError` |
| 7 | List dependencies correct | After A->B, A->C: `listDependencies(A)` returns [B, C] |

**File**: `src/__tests__/lib/store/task-board-store.test.ts`

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | `hydrate` populates columns | Correct task IDs in each status column |
| 2 | `addTask` appends to correct column | New task appears at end of its status column |
| 3 | `moveTask` removes from old, adds to new | Column arrays updated correctly |
| 4 | `removeTask` clears selection if selected | `selectedTaskId` becomes null |
| 5 | `updateTask` moves if status changed | Task moves between columns on status change |

### Integration Tests

These require a test database. Use `vitest` with a setup that creates/drops a test schema.

| # | Test | What it verifies |
|---|------|-----------------|
| 1 | Full cycle detection under concurrency | Two transactions adding edges that would create a cycle -- one succeeds, one is rejected |
| 2 | Cursor pagination end-to-end | Create 60 tasks, fetch with limit=50, verify nextCursor, fetch again |
| 3 | Task deletion cascades | Delete task with dependencies and events, verify cascade |
| 4 | Status transition audit trail | Change status, verify `task_events` row created |

---

## Verification

Phase 3 is complete when all of the following are true:

1. **Kanban board renders** at `/tasks` with 5 status columns (todo, in_progress, blocked, done, cancelled)
2. **Task creation works** via both the dialog and inline quick-add at column bottom
3. **Clicking a card opens the detail sheet** on the right side (~40% viewport)
4. **Status changes** via dropdown in detail sheet move the card between columns
5. **Agent assignment** dropdown works (populated from agents table)
6. **Subtasks** can be added inline from the detail sheet
7. **Dependencies** can be added/removed; cycle detection rejects cycles with a user-visible error message
8. **Cursor pagination** loads more tasks when clicking "Load more" in a column
9. **API routes** return correct response envelopes (`{ data }`, `{ data, meta }`, `{ error }`)
10. **All unit tests pass**: `pnpm vitest run src/__tests__/lib/services/task-service.test.ts src/__tests__/lib/services/dependency-service.test.ts src/__tests__/lib/store/task-board-store.test.ts`
11. **All integration tests pass** (if test DB is configured)
12. **No drag-and-drop** -- board is static (DnD is Phase 5)
13. **Execution history section** in detail sheet shows placeholder text (Phase 4)

### Manual Smoke Test

```
1. Navigate to /tasks
2. Click "New Task" -> fill form -> Create
3. Verify card appears in "To Do" column
4. Click the card -> detail sheet opens
5. Change status to "In Progress" -> card moves to In Progress column
6. Add a subtask in the detail sheet
7. Create another task, add first task as dependency
8. Try to create a circular dependency -> verify error message
9. Scroll a column to bottom -> click "Load more" (need >50 tasks)
10. Use quick-add at bottom of "Blocked" column
```
