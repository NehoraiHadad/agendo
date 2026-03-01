import { eq, and, sql, desc, asc, ilike } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, taskDependencies, taskEvents, agents } from '@/lib/db/schema';
import { isValidTaskTransition } from '@/lib/state-machines';
import { ConflictError } from '@/lib/errors';
import { requireFound } from '@/lib/api-handler';
import { SORT_ORDER_GAP, computeSortOrder } from '@/lib/sort-order';
import { sendPushToAll } from '@/lib/services/notification-service';
import type { Task, TaskStatus } from '@/lib/types';
import type { TaskBoardItem } from '@/lib/services/task-queries';
import { listTasksBoardItems } from '@/lib/services/task-queries';
export type { TaskBoardItem } from '@/lib/services/task-queries';
export { listTasksBoardItems };

// --- Types ---

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
  isAdHoc?: boolean;
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
  includeAdHoc?: boolean;
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
      isAdHoc: input.isAdHoc ?? false,
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
    if (!isValidTaskTransition(existing.status, input.status)) {
      throw new ConflictError(`Invalid status transition: ${existing.status} -> ${input.status}`);
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

  const result = await listTasksBoardItems(conditions, {
    limit: limit + 1,
    includeAdHoc: options.includeAdHoc,
  });

  const hasMore = result.length > limit;
  const page = hasMore ? result.slice(0, limit) : result;
  const nextCursor = hasMore ? String(page[page.length - 1].sortOrder) : null;

  return { tasks: page, nextCursor };
}

export async function listSubtasks(parentTaskId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(asc(tasks.sortOrder));
}

export interface ReorderTaskInput {
  status?: TaskStatus;
  afterSortOrder: number | null;
  beforeSortOrder: number | null;
}

export async function reorderTask(id: string, input: ReorderTaskInput): Promise<Task> {
  const existing = await getTaskById(id);

  // Validate status transition if changing columns
  if (input.status && input.status !== existing.status) {
    if (!isValidTaskTransition(existing.status, input.status)) {
      throw new ConflictError(`Invalid status transition: ${existing.status} -> ${input.status}`);
    }
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
