'use client';

import { useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { updateTaskStatusAction } from '@/lib/actions/task-actions';
import { useTaskBoardStore, BOARD_COLUMNS } from '@/lib/store/task-board-store';
import type { TaskStatus } from '@/lib/types';

interface TaskDetailHeaderProps {
  task: {
    id: string;
    title: string;
    description: string | null;
    status: string;
    priority: number;
  };
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

const PRIORITY_COLORS: Record<number, string> = {
  1: 'text-red-400',
  2: 'text-orange-400',
  3: 'text-blue-400',
  4: 'text-zinc-400',
  5: 'text-zinc-500',
};

export function TaskDetailHeader({ task }: TaskDetailHeaderProps) {
  const moveTask = useTaskBoardStore((s) => s.moveTask);
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
      <div className="flex items-start gap-2">
        <h2 className="flex-1 text-base font-semibold leading-snug">{task.title}</h2>
        <span className={`shrink-0 text-xs font-mono font-medium mt-0.5 ${PRIORITY_COLORS[task.priority] ?? 'text-zinc-400'}`}>
          P{task.priority}
        </span>
      </div>

      {task.description && (
        <p className="text-sm text-muted-foreground/70 leading-relaxed">{task.description}</p>
      )}

      <Select
        value={task.status}
        onValueChange={(v) => handleStatusChange(v as TaskStatus)}
        disabled={isPending}
      >
        <SelectTrigger className="w-full">
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
    </div>
  );
}
