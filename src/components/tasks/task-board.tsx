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
      <div className="flex items-center justify-between border-b px-6 py-4">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <TaskCreateDialog />
      </div>

      <div className="flex flex-1 gap-4 overflow-x-auto p-4">
        {BOARD_COLUMNS.map((status) => (
          <TaskColumn key={status} status={status} label={COLUMN_LABELS[status]} />
        ))}
      </div>

      {selectedTaskId && <TaskDetailSheet key={selectedTaskId} taskId={selectedTaskId} />}
    </div>
  );
}
