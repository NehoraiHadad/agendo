/**
 * Raw SQL queries for the task service.
 *
 * Separates `db.execute()` raw SQL from the Drizzle ORM operations in
 * task-service.ts. This module is the only place that uses a full SQL template
 * for task aggregation — all other queries use the Drizzle query builder.
 */

import { sql, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, projects } from '@/lib/db/schema';
import type { Task, TaskStatus } from '@/lib/types';

export interface TaskBoardItem extends Task {
  subtaskTotal: number;
  subtaskDone: number;
}

/**
 * Run a LEFT JOIN subquery to attach subtaskTotal and subtaskDone counts to each task row.
 */
export async function listTasksBoardItems(
  conditions: ReturnType<typeof and>[],
  options: { limit?: number; includeAdHoc?: boolean } = {},
): Promise<TaskBoardItem[]> {
  const limit = options.limit;

  // Filter out tasks belonging to soft-deleted projects
  const activeProjectFilter = sql`(${tasks.projectId} IS NULL OR ${projects.isActive} = true)`;
  // Exclude ad-hoc tasks from board views unless explicitly requested
  const adHocFilter = options.includeAdHoc ? undefined : sql`${tasks.isAdHoc} = false`;
  const baseConditions = adHocFilter ? [activeProjectFilter, adHocFilter] : [activeProjectFilter];
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
    isAdHoc: Boolean(row.is_ad_hoc),
    dueAt: row.due_at != null ? new Date(row.due_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    subtaskTotal: row.subtask_total as number,
    subtaskDone: row.subtask_done as number,
  }));
}
