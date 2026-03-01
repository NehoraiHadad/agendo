'use client';

import { memo, useCallback } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { TaskCard } from './task-card';
import { TaskQuickAdd } from './task-quick-add';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type { TaskStatus } from '@/lib/types';

interface TaskColumnProps {
  status: TaskStatus;
  label: string;
  filteredTaskIds?: string[];
}

/* ─── Status visual config ─────────────────────────────────── */

interface ColumnConfig {
  accent: string; // top border gradient
  countBg: string; // task count pill bg
  countText: string; // task count pill text
  emptyIcon: string; // emoji/icon for empty state
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

/* ─── Component ────────────────────────────────────────────── */

export const TaskColumn = memo(function TaskColumn({
  status,
  label,
  filteredTaskIds,
}: TaskColumnProps) {
  const allTaskIds = useTaskBoardStore((s) => s.columns[status]);
  const taskIds = filteredTaskIds ?? allTaskIds;
  const cursor = useTaskBoardStore((s) => s.cursors[status]);
  const isLoading = useTaskBoardStore((s) => s.loading[status]);
  const appendToColumn = useTaskBoardStore((s) => s.appendToColumn);
  const setColumnLoading = useTaskBoardStore((s) => s.setColumnLoading);

  const { setNodeRef, isOver } = useDroppable({ id: `column-${status}` });

  const cfg = COLUMN_CONFIG[status];

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
          'border-primary/25 bg-[oklch(0.09_0.005_280)] shadow-[0_0_0_1px_oklch(0.7_0.18_280/0.15)]',
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

      <ScrollArea className="flex-1 px-2 pb-2">
        <div ref={setNodeRef} className="flex min-h-[40px] flex-col gap-2">
          <SortableContext items={allTaskIds} strategy={verticalListSortingStrategy}>
            {taskIds.map((id) => (
              <TaskCard key={id} taskId={id} />
            ))}
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
      </ScrollArea>

      <TaskQuickAdd status={status} />
    </div>
  );
});
