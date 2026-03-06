'use client';

import { memo, useCallback, useMemo } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { TaskCard } from './task-card';
import { TaskQuickAdd } from './task-quick-add';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TaskStatus } from '@/lib/types';

/** Client-side valid transitions (mirrors src/lib/state-machines.ts) */
const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set(['in_progress', 'cancelled', 'blocked']),
  in_progress: new Set(['done', 'blocked', 'cancelled', 'todo']),
  blocked: new Set(['todo', 'in_progress', 'cancelled']),
  done: new Set(['todo']),
  cancelled: new Set(['todo']),
};

interface TaskColumnProps {
  status: TaskStatus;
  label: string;
  filteredTaskIds?: string[];
  /** Status of the task currently being dragged (null when not dragging) */
  dragSourceStatus?: TaskStatus | null;
}

/* ─── Status visual config ─────────────────────────────────── */

interface ColumnConfig {
  accent: string;
  countBg: string;
  countText: string;
  emptyIcon: string;
  emptyText: string;
}

const COLUMN_CONFIG: Record<TaskStatus, ColumnConfig> = {
  todo: {
    accent: 'from-zinc-500/50 via-zinc-500/20 to-transparent',
    countBg: 'bg-zinc-500/10 border-zinc-600/20 text-zinc-400',
    countText: 'text-zinc-400',
    emptyIcon: '○',
    emptyText: 'Nothing here yet',
  },
  in_progress: {
    accent: 'from-blue-500/60 via-blue-500/20 to-transparent',
    countBg: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
    countText: 'text-blue-400',
    emptyIcon: '◎',
    emptyText: 'No active tasks',
  },
  blocked: {
    accent: 'from-orange-500/60 via-orange-500/20 to-transparent',
    countBg: 'bg-orange-500/10 border-orange-500/20 text-orange-400',
    countText: 'text-orange-400',
    emptyIcon: '⊘',
    emptyText: 'Nothing blocked',
  },
  done: {
    accent: 'from-emerald-500/60 via-emerald-500/20 to-transparent',
    countBg: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    countText: 'text-emerald-400',
    emptyIcon: '✓',
    emptyText: 'All clear',
  },
  cancelled: {
    accent: 'from-zinc-600/40 via-zinc-600/15 to-transparent',
    countBg: 'bg-zinc-600/10 border-zinc-700/20 text-zinc-500',
    countText: 'text-zinc-500',
    emptyIcon: '×',
    emptyText: 'None cancelled',
  },
};

/* ─── Stacked card wrapper ─────────────────────────────────── */

interface CardStackProps {
  childCount: number;
  isCollapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

/**
 * Wraps a parent TaskCard with a visual "card stack" when collapsed.
 * Card-edge strips peek out below the real card — like a pile of cards on a desk.
 * An invisible overlay intercepts clicks so the detail sheet does NOT open.
 * When expanded, the card works normally and a collapse bar appears below children.
 */
const CardStack = memo(function CardStack({
  childCount,
  isCollapsed,
  onToggle,
  children,
}: CardStackProps) {
  if (!isCollapsed) {
    return (
      <div className="relative">
        {children}
        {/* Collapse trigger — subtle clickable bar between parent and children */}
        <button
          onClick={onToggle}
          className={cn(
            'flex w-full items-center justify-center gap-1.5 py-1 -mb-0.5',
            'text-[10px] text-muted-foreground/25 hover:text-muted-foreground/50',
            'transition-colors duration-150',
          )}
        >
          <span className="h-px flex-1 max-w-8 bg-current" />
          <span className="tabular-nums">
            {childCount} subtask{childCount !== 1 ? 's' : ''}
          </span>
          <span className="h-px flex-1 max-w-8 bg-current" />
        </button>
      </div>
    );
  }

  const layers = Math.min(childCount, 3);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      className="relative w-full text-left group/stack cursor-pointer"
      aria-label={`Expand ${childCount} subtask${childCount !== 1 ? 's' : ''}`}
    >
      {/* The real card — sits on top of the pile */}
      <div className="relative z-10 pointer-events-none">{children}</div>

      {/* Card-edge strips peeking below — each one slightly inset + offset down.
          These are visible solid strips, not subtle ghost borders. */}
      <div className="relative z-0 -mt-1.5">
        {/* First card edge (closest to parent) */}
        <div
          className={cn(
            'mx-2 h-[6px] rounded-b-md',
            'border-x border-b border-white/[0.08]',
            'bg-[oklch(0.10_0_0)]',
            'transition-all duration-200',
            'group-hover/stack:bg-[oklch(0.11_0.005_280)] group-hover/stack:border-white/[0.12]',
          )}
        />
        {/* Second card edge */}
        {layers >= 2 && (
          <div
            className={cn(
              'mx-4 h-[5px] -mt-px rounded-b-md',
              'border-x border-b border-white/[0.06]',
              'bg-[oklch(0.09_0_0)]',
              'transition-all duration-200 delay-[50ms]',
              'group-hover/stack:bg-[oklch(0.10_0.003_280)] group-hover/stack:border-white/[0.09]',
            )}
          />
        )}
        {/* Third card edge */}
        {layers >= 3 && (
          <div
            className={cn(
              'mx-6 h-[4px] -mt-px rounded-b-md',
              'border-x border-b border-white/[0.04]',
              'bg-[oklch(0.08_0_0)]',
              'transition-all duration-200 delay-100',
              'group-hover/stack:bg-[oklch(0.09_0.002_280)] group-hover/stack:border-white/[0.07]',
            )}
          />
        )}
      </div>

      {/* Count badge — centered below the stack */}
      <div
        className={cn(
          'flex items-center justify-center mt-1',
          'text-[10px] font-medium tabular-nums text-muted-foreground/35',
          'transition-colors duration-200',
          'group-hover/stack:text-muted-foreground/60',
        )}
      >
        {childCount} subtask{childCount !== 1 ? 's' : ''} — click to expand
      </div>
    </div>
  );
});

/* ─── Grouped rendering types ──────────────────────────────── */

interface GroupedItem {
  type: 'standalone' | 'group-stack' | 'group-child';
  taskId: string;
  parentId?: string;
  childCount?: number;
  isCollapsed?: boolean;
}

/* ─── Component ────────────────────────────────────────────── */

export const TaskColumn = memo(function TaskColumn({
  status,
  label,
  filteredTaskIds,
  dragSourceStatus,
}: TaskColumnProps) {
  const allTaskIds = useTaskBoardStore((s) => s.columns[status]);
  // Determine if this column is a valid drop target for the currently dragged task
  const isInvalidDrop =
    dragSourceStatus != null &&
    dragSourceStatus !== status &&
    !VALID_TRANSITIONS[dragSourceStatus].has(status);
  const taskIds = filteredTaskIds ?? allTaskIds;
  const tasksById = useTaskBoardStore((s) => s.tasksById);
  const cursor = useTaskBoardStore((s) => s.cursors[status]);
  const isLoading = useTaskBoardStore((s) => s.loading[status]);
  const appendToColumn = useTaskBoardStore((s) => s.appendToColumn);
  const setColumnLoading = useTaskBoardStore((s) => s.setColumnLoading);
  const collapsedParents = useTaskBoardStore((s) => s.collapsedParents);
  const toggleCollapsed = useTaskBoardStore((s) => s.toggleCollapsed);

  const { setNodeRef, isOver } = useDroppable({ id: `column-${status}` });

  const cfg = COLUMN_CONFIG[status];

  // Build grouped items: group subtasks under their parent when both exist in this column
  const groupedItems = useMemo(() => {
    const columnIdSet = new Set(taskIds);
    const childrenByParent = new Map<string, string[]>();
    const childIds = new Set<string>();

    for (const id of taskIds) {
      const task = tasksById[id];
      if (!task?.parentTaskId) continue;
      if (!columnIdSet.has(task.parentTaskId)) continue;

      childIds.add(id);
      const existing = childrenByParent.get(task.parentTaskId);
      if (existing) {
        existing.push(id);
      } else {
        childrenByParent.set(task.parentTaskId, [id]);
      }
    }

    const items: GroupedItem[] = [];

    for (const id of taskIds) {
      if (childIds.has(id)) continue;

      const children = childrenByParent.get(id);
      if (children && children.length > 0) {
        const isCollapsed = collapsedParents.has(id);
        // Parent as stack (renders card + children inline)
        items.push({
          type: 'group-stack',
          taskId: id,
          childCount: children.length,
          isCollapsed,
        });
        // Children (only when expanded)
        if (!isCollapsed) {
          for (const childId of children) {
            items.push({ type: 'group-child', taskId: childId, parentId: id });
          }
        }
      } else {
        items.push({ type: 'standalone', taskId: id });
      }
    }

    return items;
  }, [taskIds, tasksById, collapsedParents]);

  const loadMore = useCallback(async () => {
    if (!cursor || isLoading) return;
    setColumnLoading(status, true);

    try {
      const res = await fetch(`/api/tasks?status=${status}&cursor=${cursor}&limit=50`);
      const json = await res.json();
      appendToColumn(status, json.data, json.meta.nextCursor);
    } finally {
      setColumnLoading(status, false);
    }
  }, [cursor, isLoading, status, appendToColumn, setColumnLoading]);

  return (
    <div
      className={cn(
        'relative flex min-w-[280px] w-[calc(85vw)] sm:w-72 shrink-0 flex-col min-h-0',
        'rounded-xl border border-white/[0.05] bg-[oklch(0.085_0_0)]',
        'transition-all duration-200',
        isOver &&
          !isInvalidDrop &&
          'border-primary/25 bg-[oklch(0.09_0.005_280)] shadow-[0_0_0_1px_oklch(0.7_0.18_280/0.15)]',
        isInvalidDrop && 'opacity-40',
      )}
    >
      {/* Status accent — gradient top border effect */}
      <div className={cn('absolute top-0 left-4 right-4 h-px bg-gradient-to-r', cfg.accent)} />

      {/* Column header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">
            {label}
          </h2>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums',
              cfg.countBg,
            )}
          >
            {taskIds.length}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 pb-2">
        <div ref={setNodeRef} className="flex min-h-full flex-col gap-1.5">
          <SortableContext items={allTaskIds} strategy={verticalListSortingStrategy}>
            {groupedItems.map((item) => {
              if (item.type === 'group-stack') {
                return (
                  <CardStack
                    key={`stack-${item.taskId}`}
                    childCount={item.childCount ?? 0}
                    isCollapsed={item.isCollapsed ?? true}
                    onToggle={() => toggleCollapsed(item.taskId)}
                  >
                    <TaskCard taskId={item.taskId} hasGroupedChildren />
                  </CardStack>
                );
              }

              if (item.type === 'group-child') {
                return (
                  <div
                    key={item.taskId}
                    className="ml-3 border-l-2 border-white/[0.06] pl-1.5 animate-in slide-in-from-top-1 fade-in duration-150"
                  >
                    <TaskCard taskId={item.taskId} isGroupChild />
                  </div>
                );
              }

              return <TaskCard key={item.taskId} taskId={item.taskId} />;
            })}
          </SortableContext>

          {cursor && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground/50 hover:text-foreground mt-1"
              onClick={loadMore}
              disabled={isLoading}
            >
              {isLoading ? (
                <span className="flex items-center gap-1.5">
                  <span className="h-1 w-1 rounded-full bg-current animate-pulse" />
                  Loading…
                </span>
              ) : (
                'Load more'
              )}
            </Button>
          )}

          {/* Empty state */}
          {taskIds.length === 0 && !isOver && (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <span className="text-2xl text-muted-foreground/15 font-light select-none">
                {cfg.emptyIcon}
              </span>
              <p className="text-xs text-muted-foreground/30">{cfg.emptyText}</p>
            </div>
          )}

          {/* Drop target hint when dragging over empty */}
          {taskIds.length === 0 && isOver && (
            <div className="h-16 rounded-lg border-2 border-dashed border-primary/30 bg-primary/[0.03] animate-pulse" />
          )}
        </div>
      </div>

      <TaskQuickAdd status={status} />
    </div>
  );
});
