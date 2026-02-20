import { eq, and, sql, desc, asc, ilike } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, taskDependencies, taskEvents, agents } from '@/lib/db/schema';
import { isValidTaskTransition } from '@/lib/state-machines';
import { NotFoundError, ConflictError } from '@/lib/errors';
import { SORT_ORDER_GAP, computeSortOrder } from '@/lib/sort-order';
import type { Task, TaskStatus } from '@/lib/types';

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
  }

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
  await getTaskById(id);
  await db.delete(tasks).where(eq(tasks.id, id));
}

export async function getTaskById(id: string): Promise<Task> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);

  if (!task) throw new NotFoundError('Task', id);
  return task;
}

export async function getTaskWithDetails(id: string): Promise<TaskWithDetails> {
  const task = await getTaskById(id);

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

export async function listTasksByStatus(
  options: ListTasksOptions,
): Promise<{ tasks: Task[]; nextCursor: string | null }> {
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

  const result = await db
    .select()
    .from(tasks)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(tasks.sortOrder))
    .limit(limit + 1);

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

  return updated;
}
