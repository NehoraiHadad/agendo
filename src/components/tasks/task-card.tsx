'use client';

import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TaskCardProps {
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

export function TaskCard({ taskId }: TaskCardProps) {
  const task = useTaskBoardStore((s) => s.tasksById[taskId]);
  const selectTask = useTaskBoardStore((s) => s.selectTask);

  if (!task) return null;

  return (
    <button
      className={cn(
        'w-full rounded-md border bg-background p-3 text-left shadow-sm',
        'transition-colors hover:border-primary/50 hover:shadow-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      onClick={() => selectTask(taskId)}
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
    </button>
  );
}
