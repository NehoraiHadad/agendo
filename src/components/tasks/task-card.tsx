'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { useExecutionStore } from '@/lib/store/execution-store';
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

const EXECUTION_STATUS_COLORS: Record<string, string> = {
  queued: 'bg-yellow-500',
  running: 'bg-green-500 animate-pulse',
  cancelling: 'bg-orange-500 animate-pulse',
};

export function TaskCard({ taskId }: TaskCardProps) {
  const task = useTaskBoardStore((s) => s.tasksById[taskId]);
  const selectTask = useTaskBoardStore((s) => s.selectTask);
  const activeExec = useExecutionStore((s) => s.getActiveExecution(taskId));

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: taskId,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  if (!task) return null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'w-full rounded-md border bg-background p-3 text-left shadow-sm',
        'transition-colors hover:border-primary/50 hover:shadow-md',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isDragging && 'opacity-30',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          className="mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:bg-muted active:cursor-grabbing"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="5" cy="3" r="1.5" />
            <circle cx="11" cy="3" r="1.5" />
            <circle cx="5" cy="8" r="1.5" />
            <circle cx="11" cy="8" r="1.5" />
            <circle cx="5" cy="13" r="1.5" />
            <circle cx="11" cy="13" r="1.5" />
          </svg>
        </button>

        <button
          className="flex-1 text-left focus-visible:outline-none"
          onClick={() => selectTask(taskId)}
        >
          <div className="flex items-center gap-2">
            <p className="flex-1 text-sm font-medium leading-tight">{task.title}</p>
            {activeExec && (
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full shrink-0',
                  EXECUTION_STATUS_COLORS[activeExec.status] ?? 'bg-gray-500',
                )}
                title={`Execution: ${activeExec.status}`}
              />
            )}
          </div>

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
      </div>
    </div>
  );
}
