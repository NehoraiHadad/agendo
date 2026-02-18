'use client';

import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface TaskDragOverlayProps {
  taskId: string;
}

const PRIORITY_COLORS: Record<number, string> = {
  1: 'bg-red-500/10 text-red-400 border-red-500/20',
  2: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  3: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  4: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20',
  5: 'bg-zinc-400/10 text-zinc-500 border-zinc-400/20',
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
        'w-[280px] rounded-lg border border-white/[0.06] bg-card p-3',
        'glow-accent scale-[1.02] rotate-1 shadow-2xl',
      )}
    >
      <p className="text-sm font-medium leading-tight">{task.title}</p>

      <div className="mt-2 flex items-center gap-2">
        <Badge variant="outline" className={cn('text-xs', PRIORITY_COLORS[task.priority])}>
          {PRIORITY_LABELS[task.priority]}
        </Badge>

        {task.assigneeAgentId && (
          <Badge variant="secondary" className="text-xs bg-white/[0.06] border border-white/[0.08] text-muted-foreground">
            Assigned
          </Badge>
        )}
      </div>

      {task.description && (
        <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground/60">{task.description}</p>
      )}
    </div>
  );
}
