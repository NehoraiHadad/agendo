'use client';

import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { useExecutionStore } from '@/lib/store/execution-store';
import { cn } from '@/lib/utils';

interface TaskCardProps {
  taskId: string;
}

/* ─── Priority config ──────────────────────────────────────── */

interface PriorityConfig {
  label: string;
  labelColor: string;
  dotColor: string;
  leftGlow: string;
  borderLeft: string;
}

const PRIORITY_CONFIG: Record<number, PriorityConfig> = {
  1: {
    label: 'Critical',
    labelColor: 'text-red-400',
    dotColor: 'bg-red-500',
    leftGlow: 'priority-glow-critical',
    borderLeft: 'border-l-red-500/70',
  },
  2: {
    label: 'High',
    labelColor: 'text-orange-400',
    dotColor: 'bg-orange-400',
    leftGlow: 'priority-glow-high',
    borderLeft: 'border-l-orange-400/70',
  },
  3: {
    label: 'Medium',
    labelColor: 'text-blue-400',
    dotColor: 'bg-blue-400',
    leftGlow: 'priority-glow-medium',
    borderLeft: 'border-l-blue-400/60',
  },
  4: {
    label: 'Low',
    labelColor: 'text-zinc-500',
    dotColor: 'bg-zinc-500',
    leftGlow: 'priority-glow-low',
    borderLeft: 'border-l-zinc-600/50',
  },
  5: {
    label: 'Lowest',
    labelColor: 'text-zinc-600',
    dotColor: 'bg-zinc-600',
    leftGlow: '',
    borderLeft: 'border-l-zinc-700/40',
  },
};

const EXECUTION_STATUS: Record<string, { color: string; animate: boolean; title: string }> = {
  queued: { color: 'bg-amber-400', animate: false, title: 'Queued' },
  running: { color: 'bg-emerald-400', animate: true, title: 'Running' },
  cancelling: { color: 'bg-orange-400', animate: true, title: 'Cancelling' },
};

/* ─── Component ────────────────────────────────────────────── */

export const TaskCard = memo(function TaskCard({ taskId }: TaskCardProps) {
  const task = useTaskBoardStore((s) => s.tasksById[taskId]);
  const selectTask = useTaskBoardStore((s) => s.selectTask);
  const project = useTaskBoardStore((s) =>
    task?.projectId ? s.projectsById[task.projectId] : undefined,
  );
  const parentTask = useTaskBoardStore((s) =>
    task?.parentTaskId ? s.tasksById[task.parentTaskId] : undefined,
  );
  const activeExec = useExecutionStore((s) => s.activeByTaskId[taskId] ?? null);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: taskId,
  });

  const pCfg = PRIORITY_CONFIG[task?.priority ?? 4];
  const projectColor = project?.color ?? null;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(projectColor ? { borderLeftColor: projectColor } : {}),
  };

  if (!task) return null;

  const execStatus = activeExec ? (EXECUTION_STATUS[activeExec.status] ?? null) : null;
  const subtaskPct =
    task.subtaskTotal > 0 ? Math.round((task.subtaskDone / task.subtaskTotal) * 100) : 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        /* base */
        'group relative w-full rounded-lg border border-l-[3px] border-white/[0.07] bg-card text-left',
        /* left border color (overridden by project color via inline style) */
        !projectColor && pCfg.borderLeft,
        /* priority left-glow (only when no project color) */
        !projectColor && pCfg.leftGlow,
        /* hover: slight elevation + brighter border */
        'transition-all duration-150 hover:-translate-y-[1px] hover:border-white/[0.14]',
        'hover:shadow-[0_4px_16px_oklch(0_0_0/0.35)]',
        /* focus */
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        /* dragging */
        isDragging && 'opacity-20 scale-[0.98] shadow-none',
      )}
    >
      {/* Active execution ribbon — top edge */}
      {execStatus && (
        <div
          className={cn(
            'absolute top-0 left-0 right-0 h-[2px] rounded-t-lg',
            execStatus.color,
            execStatus.animate && 'animate-pulse',
          )}
        />
      )}

      <div className="flex items-start gap-2 p-3">
        {/* Drag handle */}
        <button
          className="flex h-9 w-7 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/25 hover:bg-white/[0.05] hover:text-muted-foreground/60 active:cursor-grabbing transition-colors"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
            <circle cx="2.5" cy="2" r="1.4" />
            <circle cx="7.5" cy="2" r="1.4" />
            <circle cx="2.5" cy="7" r="1.4" />
            <circle cx="7.5" cy="7" r="1.4" />
            <circle cx="2.5" cy="12" r="1.4" />
            <circle cx="7.5" cy="12" r="1.4" />
          </svg>
        </button>

        {/* Main content */}
        <button
          className="flex-1 text-left focus-visible:outline-none min-w-0"
          onClick={() => selectTask(taskId)}
        >
          {/* Parent task breadcrumb */}
          {parentTask && (
            <span
              role="button"
              tabIndex={0}
              className="block text-[10px] text-muted-foreground/35 hover:text-muted-foreground/60 truncate max-w-[160px] mb-1 text-left cursor-pointer leading-none transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                selectTask(parentTask.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  selectTask(parentTask.id);
                }
              }}
            >
              ↳ {parentTask.title}
            </span>
          )}

          {/* Title row */}
          <div className="flex items-start gap-1.5">
            <p className="flex-1 text-sm font-medium leading-snug text-foreground/90 group-hover:text-foreground transition-colors">
              {task.title}
            </p>
            {execStatus && (
              <span
                className={cn(
                  'mt-0.5 inline-flex items-center gap-1 shrink-0 text-[9px] font-medium uppercase tracking-wide rounded-full px-1.5 py-0.5',
                  activeExec?.status === 'running'
                    ? 'bg-emerald-500/15 text-emerald-400'
                    : activeExec?.status === 'queued'
                      ? 'bg-amber-500/15 text-amber-400'
                      : 'bg-orange-500/15 text-orange-400',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-1.5 w-1.5 rounded-full',
                    execStatus.color,
                    execStatus.animate && 'animate-pulse',
                  )}
                />
                {activeExec?.status}
              </span>
            )}
          </div>

          {/* Description snippet */}
          {task.description && (
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground/50 leading-relaxed">
              {task.description}
            </p>
          )}

          {/* Subtask progress */}
          {task.subtaskTotal > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="flex-1 h-1 rounded-full bg-white/[0.06] overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-300',
                    subtaskPct === 100 ? 'bg-emerald-400/80' : 'bg-primary/50',
                  )}
                  style={{ width: `${subtaskPct}%` }}
                />
              </div>
              <span
                className={cn(
                  'text-[10px] tabular-nums font-medium shrink-0',
                  subtaskPct === 100 ? 'text-emerald-400' : 'text-muted-foreground/45',
                )}
              >
                {task.subtaskDone}/{task.subtaskTotal}
              </span>
            </div>
          )}

          {/* Footer chips */}
          <div className="mt-2 flex items-center gap-1.5 flex-wrap">
            {/* Priority / Ad-hoc chip */}
            {task.isAdHoc ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-400/70 bg-amber-500/[0.07] border border-amber-500/15 rounded-full px-2 py-0.5 font-medium">
                Ad-hoc
              </span>
            ) : (
              <span
                className={cn(
                  'inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-2 py-0.5 border',
                  {
                    'text-red-400 bg-red-500/[0.08] border-red-500/20': task.priority === 1,
                    'text-orange-400 bg-orange-500/[0.08] border-orange-500/20':
                      task.priority === 2,
                    'text-blue-400 bg-blue-500/[0.07] border-blue-500/15': task.priority === 3,
                    'text-zinc-500 bg-zinc-500/[0.06] border-zinc-600/15': task.priority === 4,
                    'text-zinc-600 bg-transparent border-zinc-700/15': task.priority === 5,
                  },
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', pCfg.dotColor)} />
                {pCfg.label}
              </span>
            )}

            {/* Assignee chip */}
            {task.assigneeAgentId && (
              <span className="inline-flex items-center gap-1 text-[10px] text-primary/70 bg-primary/[0.07] border border-primary/15 rounded-full px-2 py-0.5 font-medium">
                <span className="h-1 w-1 rounded-full bg-primary/60 shrink-0" />
                Assigned
              </span>
            )}

            {/* Project name */}
            {project && (
              <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/45 font-medium">
                <span
                  className="h-1.5 w-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: project.color ?? '#6366f1' }}
                />
                {project.name}
              </span>
            )}
          </div>
        </button>
      </div>
    </div>
  );
});
