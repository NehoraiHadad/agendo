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
 * concurrent operations from creating cycles.
 */
export async function addDependency(taskId: string, dependsOnTaskId: string): Promise<Dependency> {
  if (taskId === dependsOnTaskId) {
    throw new ConflictError('A task cannot depend on itself');
  }

  return db.transaction(async (tx) => {
    // Lock both task rows to prevent concurrent modifications
    const lockedTasks = await tx.execute(
      sql`SELECT id FROM tasks WHERE id IN (${taskId}, ${dependsOnTaskId}) FOR UPDATE`,
    );

    if ((lockedTasks as unknown as { rowCount: number }).rowCount < 2) {
      throw new NotFoundError('One or both tasks not found');
    }

    // Check for existing dependency (idempotency)
    const [existing] = await tx
      .select()
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
        ),
      )
      .limit(1);

    if (existing) {
      return existing;
    }

    // Lock ALL dependency edges reachable from dependsOnTaskId
    const reachableEdges = await tx.execute(sql`
      WITH RECURSIVE dep_chain AS (
        SELECT task_id, depends_on_task_id
        FROM task_dependencies
        WHERE task_id = ${dependsOnTaskId}

        UNION

        SELECT td.task_id, td.depends_on_task_id
        FROM task_dependencies td
        INNER JOIN dep_chain dc ON td.task_id = dc.depends_on_task_id
      )
      SELECT task_id, depends_on_task_id FROM dep_chain
      FOR UPDATE OF task_dependencies
    `);

    // DFS cycle check: does dependsOnTaskId transitively depend on taskId?
    const rows = (
      reachableEdges as unknown as {
        rows: Array<{
          task_id: string;
          depends_on_task_id: string;
        }>;
      }
    ).rows;

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
      const current = stack.pop() as string;
      if (current === taskId) {
        throw new ConflictError(
          `Adding dependency would create a cycle: task ${taskId} is already a transitive dependency of task ${dependsOnTaskId}`,
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

    // No cycle detected, insert the new dependency
    const [dependency] = await tx
      .insert(taskDependencies)
      .values({ taskId, dependsOnTaskId })
      .returning();

    return dependency;
  });
}

export async function removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
  const result = await db
    .delete(taskDependencies)
    .where(
      and(
        eq(taskDependencies.taskId, taskId),
        eq(taskDependencies.dependsOnTaskId, dependsOnTaskId),
      ),
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
  taskId: string,
): Promise<Array<{ id: string; title: string; status: string }>> {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(eq(taskDependencies.taskId, taskId));
}

/**
 * List all tasks that depend on a given task (tasks it blocks).
 */
export async function listDependents(
  taskId: string,
): Promise<Array<{ id: string; title: string; status: string }>> {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
    .where(eq(taskDependencies.dependsOnTaskId, taskId));
}
