'use client';

import { useCallback } from 'react';
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
}

export function TaskColumn({ status, label }: TaskColumnProps) {
  const taskIds = useTaskBoardStore((s) => s.columns[status]);
  const cursor = useTaskBoardStore((s) => s.cursors[status]);
  const isLoading = useTaskBoardStore((s) => s.loading[status]);
  const appendToColumn = useTaskBoardStore((s) => s.appendToColumn);
  const setColumnLoading = useTaskBoardStore((s) => s.setColumnLoading);

  const { setNodeRef, isOver } = useDroppable({ id: `column-${status}` });

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
        'flex min-w-[280px] flex-col rounded-xl border border-white/[0.05] bg-white/[0.02] transition-colors',
        isOver && 'border-primary/30 bg-primary/[0.03] shadow-[inset_0_0_0_1px_oklch(0.7_0.18_280/0.2)]',
      )}
    >
      <div className="flex items-center justify-between border-b border-white/[0.05] px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">{label}</h2>
          <span className="rounded-full bg-white/[0.06] border border-white/[0.06] px-2 py-0.5 text-xs text-muted-foreground/70">
            {taskIds.length}
          </span>
        </div>
      </div>

      <ScrollArea className="flex-1 p-2">
        <div ref={setNodeRef} className="flex min-h-[40px] flex-col gap-2">
          <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
            {taskIds.map((id) => (
              <TaskCard key={id} taskId={id} />
            ))}
          </SortableContext>

          {cursor && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground/60 hover:text-foreground"
              onClick={loadMore}
              disabled={isLoading}
            >
              {isLoading ? 'Loading...' : 'Load more'}
            </Button>
          )}

          {taskIds.length === 0 && !isOver && (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground/40">No tasks</p>
          )}
        </div>
      </ScrollArea>

      <TaskQuickAdd status={status} />
    </div>
  );
}
