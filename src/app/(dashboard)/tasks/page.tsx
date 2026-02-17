export const dynamic = 'force-dynamic';

import { listTasksByStatus } from '@/lib/services/task-service';
import { TaskBoard } from '@/components/tasks/task-board';
import type { Task, TaskStatus } from '@/lib/types';

const BOARD_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];

export default async function TasksPage() {
  const results = await Promise.all(
    BOARD_STATUSES.map((status) => listTasksByStatus({ status, limit: 50 })),
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
