'use client';

import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TaskDragOverlayProps {
  taskId: string;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: 'bg-red-500/10 text-red-500',
  2: 'bg-orange-500/10 text-orange-500',
  3: 'bg-blue-500/10 text-blue-500',
  4: 'bg-zinc-500/10 text-zinc-500',
  5: 'bg-zinc-400/10 text-zinc-400',
};

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Critical',
  2: 'High',
  3: 'Medium',
  4: 'Low',
  5: 'Lowest',
};

export function TaskDragOverlay({ taskId }: TaskDragOverlayProps) {
  const task = useTaskBoardStore((s) => s.tasksById[taskId]);

  if (!task) return null;

  return (
    <div
      className={cn(
        'w-[280px] rounded-md border bg-background p-3 shadow-lg',
        'rotate-2 opacity-90',
      )}
    >
      <p className="text-sm font-medium leading-tight">{task.title}</p>

      <div className="mt-2 flex items-center gap-2">
        <Badge variant="outline" className={cn('text-xs', PRIORITY_COLORS[task.priority])}>
          {PRIORITY_LABELS[task.priority]}
        </Badge>

        {task.assigneeAgentId && (
          <Badge variant="secondary" className="text-xs">
            Assigned
          </Badge>
        )}
      </div>

      {task.description && (
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
      )}
    </div>
  );
}
