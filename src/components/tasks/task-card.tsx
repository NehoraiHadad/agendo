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

const PRIORITY_LEFT_BORDER: Record<number, string> = {
  1: 'border-l-2 border-l-red-500/60',
  2: 'border-l-2 border-l-orange-500/60',
  3: 'border-l-2 border-l-blue-500/60',
  4: 'border-l-2 border-l-zinc-500/40',
  5: 'border-l-2 border-l-zinc-400/30',
};

const EXECUTION_STATUS_COLORS: Record<string, string> = {
  queued: 'bg-amber-400',
  running: 'bg-emerald-400 animate-pulse',
  cancelling: 'bg-orange-400 animate-pulse',
};

export function TaskCard({ taskId }: TaskCardProps) {
  const task = useTaskBoardStore((s) => s.tasksById[taskId]);
  const selectTask = useTaskBoardStore((s) => s.selectTask);
  const project = useTaskBoardStore((s) =>
    task?.projectId ? s.projectsById[task.projectId] : undefined,
  );
  const activeExec = useExecutionStore((s) => s.getActiveExecution(taskId));

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: taskId,
  });

  const projectColor = project?.color ?? null;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(projectColor ? { borderLeftColor: projectColor } : {}),
  };

  if (!task) return null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'w-full rounded-lg border border-white/[0.06] bg-card p-3 text-left',
        'transition-all duration-200 hover:border-white/[0.12]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        project ? 'border-l-4' : (PRIORITY_LEFT_BORDER[task.priority] ?? ''),
        isDragging && 'opacity-20 scale-[0.98]',
      )}
    >
      <div className="flex items-start gap-2">
        <button
          className="mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground/40 hover:bg-white/[0.05] hover:text-muted-foreground active:cursor-grabbing"
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
              <Badge variant="secondary" className="text-xs bg-white/[0.06] border border-white/[0.08] text-muted-foreground">
                Assigned
              </Badge>
            )}

            {project && (
              <span className="text-[10px] text-muted-foreground/50">{project.name}</span>
            )}
          </div>

          {task.description && (
            <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground/60">{task.description}</p>
          )}
        </button>
      </div>
    </div>
  );
}
