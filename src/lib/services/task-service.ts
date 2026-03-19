import { eq, and, sql, desc, asc, ilike, or } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, taskDependencies, taskEvents, agents, projects } from '@/lib/db/schema';
import { taskMachine } from '@/lib/state-machines';
import { requireFound } from '@/lib/api-handler';
import { SORT_ORDER_GAP, computeSortOrder } from '@/lib/sort-order';
import { sendPushToAll } from '@/lib/services/notification-service';
import type { Task, TaskStatus } from '@/lib/types';

// --- Types ---

export interface TaskBoardItem extends Task {
  subtaskTotal: number;
  subtaskDone: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  parentTaskId?: string;
  assigneeAgentId?: string;
  projectId?: string;
  inputContext?: Record<string, unknown>;
  dueAt?: Date;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: number;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  inputContext?: Record<string, unknown>;
  dueAt?: Date | null;
  parentTaskId?: string | null;
  executionOrder?: number | null;
}

export interface TaskWithDetails extends Task {
  subtaskCount: number;
  completedSubtaskCount: number;
  dependencyCount: number;
  blockedByCount: number;
  assignee: { id: string; name: string; slug: string } | null;
  parentTask: { id: string; title: string } | null;
}

export interface ListTasksOptions {
  status?: TaskStatus;
  cursor?: string;
  limit?: number;
  parentTaskId?: string;
  projectId?: string;
  q?: string;
}

// --- Implementation ---

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
 * Reindex all sort_order values in a column with fresh gaps.
 * Runs inside a transaction so a partial failure leaves the column unchanged.
 */
export async function reindexColumn(status: TaskStatus): Promise<void> {
  const columnTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, status))
    .orderBy(asc(tasks.sortOrder));

  if (columnTasks.length === 0) return;

  await db.transaction(async (tx) => {
    for (let i = 0; i < columnTasks.length; i++) {
      await tx
        .update(tasks)
        .set({ sortOrder: (i + 1) * SORT_ORDER_GAP })
        .where(eq(tasks.id, columnTasks[i].id));
    }
  });
}

/**
 * Touch a task's updatedAt so SSE poll picks it up (used for parent propagation).
 */
async function touchTask(id: string): Promise<void> {
  await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, id));
}

/**
 * Run a LEFT JOIN subquery to attach subtaskTotal and subtaskDone counts to each task row.
 */
export async function listTasksBoardItems(
  conditions: ReturnType<typeof and>[],
  options: { limit?: number } = {},
): Promise<TaskBoardItem[]> {
  const limit = options.limit;

  // Filter out tasks belonging to soft-deleted projects
  const activeProjectFilter = sql`(${tasks.projectId} IS NULL OR ${projects.isActive} = true)`;
  const baseConditions = [activeProjectFilter];
  const allConditions =
    conditions.length > 0
      ? and(...(conditions as Parameters<typeof and>), ...baseConditions)
      : and(...baseConditions);

  // Use raw SQL for the LEFT JOIN aggregation
  const query = sql`
    SELECT tasks.*,
      COALESCE(sub.total, 0)::int AS subtask_total,
      COALESCE(sub.done,  0)::int AS subtask_done
    FROM tasks
    LEFT JOIN ${projects} ON ${projects.id} = ${tasks.projectId}
    LEFT JOIN (
      SELECT parent_task_id,
        COUNT(*)                                       AS total,
        COUNT(*) FILTER (WHERE status = 'done')        AS done
      FROM tasks child
      WHERE child.parent_task_id IS NOT NULL
      GROUP BY child.parent_task_id
    ) sub ON sub.parent_task_id = tasks.id
    WHERE ${allConditions}
    ORDER BY tasks.sort_order ASC
    ${limit !== undefined ? sql`LIMIT ${limit}` : sql``}
  `;

  const result = await db.execute(query);
  // node-postgres returns QueryResult with .rows; drizzle may or may not unwrap it
  const rows: Array<Record<string, unknown>> = Array.isArray(result)
    ? (result as unknown as Array<Record<string, unknown>>)
    : ((result as unknown as { rows: Array<Record<string, unknown>> }).rows ?? []);

  return rows.map((row) => ({
    id: row.id as string,
    ownerId: row.owner_id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    status: row.status as TaskStatus,
    priority: row.priority as number,
    sortOrder: row.sort_order as number,
    parentTaskId: (row.parent_task_id as string | null) ?? null,
    assigneeAgentId: (row.assignee_agent_id as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    inputContext: (row.input_context as Record<string, unknown>) ?? {},
    dueAt: row.due_at != null ? new Date(row.due_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    executionOrder: (row.execution_order as number | null) ?? null,
    subtaskTotal: row.subtask_total as number,
    subtaskDone: row.subtask_done as number,
  }));
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
      projectId: input.projectId,
      inputContext: input.inputContext ?? {},
      dueAt: input.dueAt,
    })
    .returning();

  await db.insert(taskEvents).values({
    taskId: task.id,
    actorType: 'user',
    eventType: 'task_created',
    payload: { title: task.title, status: task.status },
  });

  if (input.parentTaskId) {
    await touchTask(input.parentTaskId);
  }

  return task;
}

export async function updateTask(id: string, input: UpdateTaskInput): Promise<Task> {
  const existing = await getTaskById(id);

  if (input.status && input.status !== existing.status) {
    taskMachine.assert(existing.status, input.status);
  }

  const [updated] = await db
    .update(tasks)
    .set({
      ...input,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();

  if (input.status && input.status !== existing.status) {
    await db.insert(taskEvents).values({
      taskId: id,
      actorType: 'user',
      eventType: 'status_changed',
      payload: { from: existing.status, to: input.status },
    });
    if (input.status === 'done') {
      void sendPushToAll({ title: 'Task completed', body: existing.title, url: '/tasks' });
    }
  }

  if (input.assigneeAgentId !== undefined && input.assigneeAgentId !== existing.assigneeAgentId) {
    await db.insert(taskEvents).values({
      taskId: id,
      actorType: 'user',
      eventType: 'assignee_changed',
      payload: { from: existing.assigneeAgentId, to: input.assigneeAgentId },
    });
  }

  // Touch parent(s) so SSE poll propagates progress updates
  if (existing.parentTaskId) {
    await touchTask(existing.parentTaskId);
  }
  if (
    input.parentTaskId !== undefined &&
    input.parentTaskId !== existing.parentTaskId &&
    input.parentTaskId
  ) {
    await touchTask(input.parentTaskId);
  }

  return updated;
}

export async function deleteTask(id: string): Promise<void> {
  const task = await getTaskById(id);
  if (task.parentTaskId) {
    await db.delete(tasks).where(eq(tasks.id, id));
    await touchTask(task.parentTaskId);
  } else {
    await db.delete(tasks).where(eq(tasks.id, id));
  }
}

export async function getTaskById(id: string): Promise<Task> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);

  return requireFound(task, 'Task', id);
}

export async function getTaskWithDetails(id: string): Promise<TaskWithDetails> {
  const task = await getTaskById(id);

  const [
    subtaskResult,
    completedSubtaskResult,
    depResult,
    blockedByResult,
    assigneeResult,
    parentResult,
  ] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.parentTaskId, id)),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, id), eq(tasks.status, 'done'))),
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
    completedSubtaskCount: completedSubtaskResult[0]?.count ?? 0,
    dependencyCount: depResult[0]?.count ?? 0,
    blockedByCount: blockedByResult[0]?.count ?? 0,
    assignee: assigneeResult[0] ?? null,
    parentTask: parentResult[0] ?? null,
  };
}

export async function listTasksByStatus(
  options: ListTasksOptions,
): Promise<{ tasks: TaskBoardItem[]; nextCursor: string | null }> {
  const limit = options.limit ?? 50;

  const conditions = [];
  if (options.status) {
    conditions.push(eq(tasks.status, options.status));
  }
  if (options.cursor) {
    conditions.push(sql`${tasks.sortOrder} > ${parseInt(options.cursor, 10)}`);
  }
  if (options.parentTaskId) {
    conditions.push(eq(tasks.parentTaskId, options.parentTaskId));
  }
  if (options.projectId) {
    conditions.push(eq(tasks.projectId, options.projectId));
  }
  if (options.q) {
    conditions.push(ilike(tasks.title, `%${options.q}%`));
  }

  const result = await listTasksBoardItems(conditions, { limit: limit + 1 });

  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;
  const nextCursor = hasMore ? String(page[page.length - 1].sortOrder) : null;

  return { tasks: page, nextCursor };
}

export async function listSubtasks(parentTaskId: string): Promise<TaskBoardItem[]> {
  return listTasksBoardItems([eq(tasks.parentTaskId, parentTaskId)]);
}

export interface ReorderTaskInput {
  status?: TaskStatus;
  afterSortOrder: number | null;
  beforeSortOrder: number | null;
}

export interface SearchTaskResult {
  id: string;
  title: string;
  status: string;
  projectName: string | null;
}

export async function searchTasks(q: string, limit = 5): Promise<SearchTaskResult[]> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      projectName: projects.name,
    })
    .from(tasks)
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(or(ilike(tasks.title, `%${q}%`), ilike(tasks.description, `%${q}%`)))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    projectName: row.projectName ?? null,
  }));
}

// --- Search Progress Notes --------------------------------------------------

/** Matches the constant in src/lib/mcp/tools/shared.ts (kept local to avoid cross-boundary import). */
const AGENT_NOTE = 'agent_note';

export interface SearchProgressNoteResult {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  projectName: string | null;
  noteSnippet: string;
}

/**
 * Search progress notes (task_events with eventType='agent_note') by note text.
 * Uses JSONB text extraction (`payload->>'note'`) so it works for any query,
 * including short commit hashes that are too small to warrant a full-text index.
 *
 * Results are deduplicated by taskId — only the most recent matching note per
 * task is returned, so the caller always gets up to `limit` distinct tasks.
 */
export async function searchProgressNotes(
  q: string,
  limit = 5,
): Promise<SearchProgressNoteResult[]> {
  // Fetch more rows than needed so deduplication still yields `limit` unique tasks.
  const rows = await db
    .select({
      taskId: tasks.id,
      taskTitle: tasks.title,
      taskStatus: tasks.status,
      projectName: projects.name,
      // Extract only the note text from the JSONB payload — avoids fetching the whole blob.
      note: sql<string>`${taskEvents.payload}->>'note'`,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(
      and(
        eq(taskEvents.eventType, AGENT_NOTE),
        ilike(sql`${taskEvents.payload}->>'note'`, `%${q}%`),
      ),
    )
    .orderBy(desc(taskEvents.createdAt))
    .limit(limit * 3);

  // Deduplicate: keep only the most-recent note per task (rows are already DESC).
  const seen = new Set<string>();
  const unique: typeof rows = [];
  for (const row of rows) {
    if (!seen.has(row.taskId)) {
      seen.add(row.taskId);
      unique.push(row);
      if (unique.length === limit) break;
    }
  }

  return unique.map((row) => {
    const note = row.note ?? '';
    // Surface a short snippet centred on the match position.
    // If indexOf misses (shouldn't happen post-ILIKE), start defaults to 0 (show beginning).
    const matchIdx = note.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, matchIdx - 30);
    const raw = note.slice(start, start + 120);
    const noteSnippet = start > 0 ? `…${raw}` : raw;
    return {
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      taskStatus: row.taskStatus,
      projectName: row.projectName ?? null,
      noteSnippet,
    };
  });
}

// --- Execution Order / Sequencing ---

export interface SetExecutionOrderInput {
  /** Ordered list of task IDs — position in the array determines executionOrder (1-based). */
  taskIds: string[];
}

/**
 * Bulk-set execution order for a list of tasks.
 * Tasks not in the list keep their current executionOrder.
 */
export async function setExecutionOrder(input: SetExecutionOrderInput): Promise<void> {
  await db.transaction(async (tx) => {
    for (let i = 0; i < input.taskIds.length; i++) {
      await tx
        .update(tasks)
        .set({ executionOrder: i + 1, updatedAt: new Date() })
        .where(eq(tasks.id, input.taskIds[i]));
    }
  });
}

/**
 * List "ready" tasks: tasks with status 'todo' whose dependencies are all done.
 * Ordered by executionOrder (nulls last), then sortOrder.
 */
export async function listReadyTasks(projectId?: string): Promise<TaskBoardItem[]> {
  const conditions = [eq(tasks.status, 'todo')];
  if (projectId) {
    conditions.push(eq(tasks.projectId, projectId));
  }

  // Subquery: tasks that have at least one incomplete dependency
  const blockedFilter = sql`NOT EXISTS (
    SELECT 1 FROM task_dependencies td
    INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
    WHERE td.task_id = tasks.id
      AND dep.status <> 'done'
  )`;
  conditions.push(blockedFilter);

  const result = await listTasksBoardItems(conditions);

  // Sort: executionOrder ASC (nulls last), then sortOrder ASC
  return result.sort((a, b) => {
    const aOrder = a.executionOrder ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.executionOrder ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.sortOrder - b.sortOrder;
  });
}

export async function reorderTask(id: string, input: ReorderTaskInput): Promise<Task> {
  const existing = await getTaskById(id);

  // Validate status transition if changing columns
  if (input.status && input.status !== existing.status) {
    taskMachine.assert(existing.status, input.status);
  }

  const { value: sortOrder, needsReindex } = computeSortOrder(
    input.afterSortOrder,
    input.beforeSortOrder,
  );

  const newStatus = input.status ?? existing.status;

  const [updated] = await db
    .update(tasks)
    .set({
      status: newStatus,
      sortOrder,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();

  if (input.status && input.status !== existing.status) {
    await db.insert(taskEvents).values({
      taskId: id,
      actorType: 'user',
      eventType: 'status_changed',
      payload: { from: existing.status, to: input.status },
    });
  }

  if (needsReindex) {
    await reindexColumn(newStatus);
  }

  // Touch parent for SSE propagation
  if (existing.parentTaskId) {
    await touchTask(existing.parentTaskId);
  }

  return updated;
}
