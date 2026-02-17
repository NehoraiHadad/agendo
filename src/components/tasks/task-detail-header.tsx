'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
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
      <h2 className="text-lg font-semibold">{task.title}</h2>

      {task.description && <p className="text-sm text-muted-foreground">{task.description}</p>}

      <div className="flex items-center gap-3">
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

        <Badge variant="outline" className="text-xs">
          P{task.priority}
        </Badge>
      </div>
    </div>
  );
}
