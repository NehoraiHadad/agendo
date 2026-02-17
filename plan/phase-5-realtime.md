# Phase 5: Drag-and-Drop + Real-Time Board Updates

> **Goal**: DnD for Kanban reordering and cross-column moves, SSE for live board state, optimistic updates with rollback.
>
> **Prerequisites**: Phase 3 (static Kanban board, task-board-store, task CRUD) and Phase 4 (execution engine, SSE log streaming) must be complete.

---

## Packages to Install

```bash
cd /home/ubuntu/projects/agent-monitor
pnpm add @dnd-kit/core@6 @dnd-kit/sortable@8 @dnd-kit/utilities@3 sonner
```

> **Note**: `sonner` is used for toast notifications on optimistic update rollback.
> Add `<Toaster />` from `sonner` to the root layout (`src/app/(dashboard)/layout.tsx`)
> if it was not already added in Phase 1. Example:
> ```tsx
> import { Toaster } from 'sonner';
> // In layout JSX:
> <Toaster position="bottom-right" />
> ```

---

## Step 1: Implement the Reorder API Route

Create the backend endpoint that handles drag-and-drop reordering.

### 1.1 Create reorder route

**File**: `src/app/api/tasks/[id]/reorder/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { tasks } from '@/lib/db/schema';
import { eq, and, gt, lt, sql } from 'drizzle-orm';
import { withErrorBoundary } from '@/lib/api-handler';

const reorderSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
  /** sort_order of the task directly above in the target column (null = top of column) */
  afterSortOrder: z.number().nullable(),
  /** sort_order of the task directly below in the target column (null = bottom of column) */
  beforeSortOrder: z.number().nullable(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = reorderSchema.parse(await req.json());

    const newSortOrder = computeSortOrder(body.afterSortOrder, body.beforeSortOrder);

    const updateFields: Record<string, unknown> = {
      sortOrder: newSortOrder,
      updatedAt: new Date(),
    };
    if (body.status) {
      updateFields.status = body.status;
    }

    const [updated] = await db
      .update(tasks)
      .set(updateFields)
      .where(eq(tasks.id, id))
      .returning();

    // Check if reindex is needed (gap < 1)
    if (needsReindex(body.afterSortOrder, body.beforeSortOrder, newSortOrder)) {
      await reindexColumn(updated.status);
    }

    return NextResponse.json({ data: updated });
  }
);
```

### 1.2 Sparse sort_order calculation utilities

> **Deduplication note**: The sort-order utilities (`computeSortOrder`, `needsReindex`,
> `reindexColumn`) should be extracted to `src/lib/sort-order.ts` during Phase 3
> implementation, since Phase 3's task-service also defines `calculateMidpoint` and
> `reindexColumn` inline. Phase 5 should import from `src/lib/sort-order.ts` instead
> of redefining these functions. The file path below is the shared location.

**File**: `src/lib/sort-order.ts`

```typescript
/** Default gap between sort_order values */
export const SORT_ORDER_GAP = 1000;

/** Minimum gap before triggering a reindex */
export const SORT_ORDER_MIN_GAP = 1;

/**
 * Compute a sort_order value between two neighbors.
 * - afterSortOrder: the card above (null = inserting at top)
 * - beforeSortOrder: the card below (null = inserting at bottom)
 */
export function computeSortOrder(
  afterSortOrder: number | null,
  beforeSortOrder: number | null,
): number {
  if (afterSortOrder === null && beforeSortOrder === null) {
    // Only card in column
    return SORT_ORDER_GAP;
  }
  if (afterSortOrder === null) {
    // Inserting at top: half of the first card's sort_order
    return Math.floor(beforeSortOrder! / 2);
  }
  if (beforeSortOrder === null) {
    // Inserting at bottom: add gap to the last card
    return afterSortOrder + SORT_ORDER_GAP;
  }
  // Between two cards: midpoint
  return Math.floor((afterSortOrder + beforeSortOrder) / 2);
}

/**
 * Returns true if the gap between neighbors has collapsed below the minimum.
 */
export function needsReindex(
  afterSortOrder: number | null,
  beforeSortOrder: number | null,
  newSortOrder: number,
): boolean {
  if (afterSortOrder !== null && newSortOrder - afterSortOrder < SORT_ORDER_MIN_GAP) {
    return true;
  }
  if (beforeSortOrder !== null && beforeSortOrder - newSortOrder < SORT_ORDER_MIN_GAP) {
    return true;
  }
  return false;
}

/**
 * Reindex all tasks in a column with fresh gaps.
 * Called when sort_order gaps collapse below SORT_ORDER_MIN_GAP.
 *
 * NOTE: During Phase 3 implementation, extract computeSortOrder, needsReindex,
 * and reindexColumn to src/lib/sort-order.ts. Phase 5 should import from there
 * instead of redefining these utilities.
 */
export async function reindexColumn(
  status: string,
): Promise<void> {
  const { db } = await import('@/lib/db');
  const { tasks } = await import('@/lib/db/schema');
  const { eq, asc } = await import('drizzle-orm');

  // TODO: Add workspaceId filter when multi-workspace is implemented
  const columnTasks = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, status))
    .orderBy(asc(tasks.sortOrder));

  // Reassign sort_order with fresh gaps
  for (let i = 0; i < columnTasks.length; i++) {
    await db
      .update(tasks)
      .set({ sortOrder: (i + 1) * SORT_ORDER_GAP })
      .where(eq(tasks.id, columnTasks[i].id));
  }
}
```

---

## Step 2: Implement the SSE Board Endpoint

### 2.1 Create board SSE route

**File**: `src/app/api/sse/board/route.ts`

This endpoint streams task change events to connected clients. It polls the database every 2 seconds (upgrade to Postgres LISTEN/NOTIFY in a later phase).

```typescript
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { tasks, executions } from '@/lib/db/schema';
import { gt, desc, eq, inArray } from 'drizzle-orm';

/**
 * Board SSE event types sent to the client.
 */
type BoardSseEvent =
  | { type: 'task_updated'; task: TaskBoardItem }
  | { type: 'task_created'; task: TaskBoardItem }
  | { type: 'task_deleted'; taskId: string }
  | { type: 'execution_status'; executionId: string; status: string; taskId: string }
  | { type: 'heartbeat' };

interface TaskBoardItem {
  id: string;
  title: string;
  status: string;
  priority: number;
  sortOrder: number;
  assigneeAgentId: string | null;
  updatedAt: string;
}

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();
  let lastPollAt = new Date();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: BoardSseEvent) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      };

      // Polling loop: every 2 seconds, query for tasks updated since last poll
      const poll = async () => {
        while (!closed) {
          try {
            const now = new Date();

            // Fetch tasks updated since last poll
            const updatedTasks = await db
              .select({
                id: tasks.id,
                title: tasks.title,
                status: tasks.status,
                priority: tasks.priority,
                sortOrder: tasks.sortOrder,
                assigneeAgentId: tasks.assigneeAgentId,
                updatedAt: tasks.updatedAt,
              })
              .from(tasks)
              .where(gt(tasks.updatedAt, lastPollAt))
              .orderBy(desc(tasks.updatedAt))
              .limit(100);

            for (const task of updatedTasks) {
              send({
                type: 'task_updated',
                task: { ...task, updatedAt: task.updatedAt.toISOString() },
              });
            }

            // Fetch execution status changes
            const activeExecutions = await db
              .select({
                id: executions.id,
                status: executions.status,
                taskId: executions.taskId,
              })
              .from(executions)
              .where(
                inArray(executions.status, ['running', 'cancelling', 'queued'])
              );

            for (const exec of activeExecutions) {
              send({
                type: 'execution_status',
                executionId: exec.id,
                status: exec.status,
                taskId: exec.taskId,
              });
            }

            lastPollAt = now;

            // Send heartbeat to keep connection alive
            send({ type: 'heartbeat' });
          } catch (err) {
            // Log error but continue polling
            console.error('[SSE board] poll error:', err);
          }

          // Wait 2 seconds before next poll
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      };

      poll();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

---

## Step 3: Upgrade Zustand Store for Optimistic Updates

### 3.1 Add optimistic move/reorder to task-board-store

**File**: `src/lib/store/task-board-store.ts` (modify existing)

Add the following methods to the existing store created in Phase 3. The store already has `columns: Record<TaskStatus, string[]>` and `tasksById: Record<string, TaskBoardItem>`.

```typescript
import { create } from 'zustand';
import type { TaskStatus } from '@/lib/types';
import { toast } from 'sonner';

interface TaskBoardItem {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  sortOrder: number;
  assigneeAgentId: string | null;
}

interface Snapshot {
  columns: Record<TaskStatus, string[]>;
  tasksById: Record<string, TaskBoardItem>;
}

interface TaskBoardStore {
  columns: Record<TaskStatus, string[]>;
  tasksById: Record<string, TaskBoardItem>;

  /** Hydrate from RSC initial data */
  hydrate: (tasks: TaskBoardItem[]) => void;

  /**
   * Optimistic cross-column move.
   * 1. Snapshot current state
   * 2. Apply move immediately in the store
   * 3. Call server action in background
   * 4. Rollback on failure with toast
   */
  moveTask: (
    taskId: string,
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    newIndex: number,
  ) => Promise<void>;

  /**
   * Optimistic within-column reorder.
   * Same snapshot/apply/rollback pattern as moveTask.
   */
  reorderTask: (
    taskId: string,
    status: TaskStatus,
    newIndex: number,
  ) => Promise<void>;

  /**
   * Apply a server-sent update from SSE.
   * Merges with pending optimistic state.
   */
  applyServerUpdate: (task: TaskBoardItem) => void;

  /** Remove a task (e.g., from SSE delete event) */
  removeTask: (taskId: string) => void;
}

export const useTaskBoardStore = create<TaskBoardStore>((set, get) => ({
  columns: {
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
    cancelled: [],
  },
  tasksById: {},

  hydrate: (tasks) => {
    const columns: Record<TaskStatus, string[]> = {
      todo: [],
      in_progress: [],
      blocked: [],
      done: [],
      cancelled: [],
    };
    const tasksById: Record<string, TaskBoardItem> = {};

    for (const task of tasks) {
      columns[task.status].push(task.id);
      tasksById[task.id] = task;
    }

    // Sort each column by sortOrder
    for (const status of Object.keys(columns) as TaskStatus[]) {
      columns[status].sort(
        (a, b) => (tasksById[a]?.sortOrder ?? 0) - (tasksById[b]?.sortOrder ?? 0)
      );
    }

    set({ columns, tasksById });
  },

  moveTask: async (taskId, fromStatus, toStatus, newIndex) => {
    const state = get();

    // 1. Snapshot
    const snapshot: Snapshot = {
      columns: structuredClone(state.columns),
      tasksById: structuredClone(state.tasksById),
    };

    // 2. Apply optimistically
    const fromColumn = [...state.columns[fromStatus]];
    const toColumn = fromStatus === toStatus
      ? fromColumn
      : [...state.columns[toStatus]];

    fromColumn.splice(fromColumn.indexOf(taskId), 1);
    if (fromStatus !== toStatus) {
      toColumn.splice(newIndex, 0, taskId);
    } else {
      fromColumn.splice(newIndex, 0, taskId);
    }

    // Compute sort_order neighbors
    const targetColumn = fromStatus === toStatus ? fromColumn : toColumn;
    const afterId = newIndex > 0 ? targetColumn[newIndex - 1] : null;
    const beforeId = newIndex < targetColumn.length - 1 ? targetColumn[newIndex + 1] : null;
    const afterSortOrder = afterId ? state.tasksById[afterId]?.sortOrder ?? null : null;
    const beforeSortOrder = beforeId ? state.tasksById[beforeId]?.sortOrder ?? null : null;

    set({
      columns: {
        ...state.columns,
        [fromStatus]: fromColumn,
        ...(fromStatus !== toStatus ? { [toStatus]: toColumn } : {}),
      },
      tasksById: {
        ...state.tasksById,
        [taskId]: { ...state.tasksById[taskId], status: toStatus },
      },
    });

    // 3. Server action
    try {
      const res = await fetch(`/api/tasks/${taskId}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: fromStatus !== toStatus ? toStatus : undefined,
          afterSortOrder,
          beforeSortOrder,
        }),
      });

      if (!res.ok) {
        throw new Error(`Reorder failed: ${res.status}`);
      }
    } catch (err) {
      // 4. Rollback
      set(snapshot);
      toast.error('Failed to move task. Reverted.');
    }
  },

  reorderTask: async (taskId, status, newIndex) => {
    // Delegate to moveTask with same status
    return get().moveTask(taskId, status, status, newIndex);
  },

  applyServerUpdate: (task) => {
    const state = get();
    const existing = state.tasksById[task.id];

    // Update tasksById
    const newTasksById = { ...state.tasksById, [task.id]: task };
    const newColumns = { ...state.columns };

    if (existing && existing.status !== task.status) {
      // Status changed: move between columns
      newColumns[existing.status] = newColumns[existing.status].filter(
        (id) => id !== task.id
      );
      if (!newColumns[task.status].includes(task.id)) {
        newColumns[task.status] = [...newColumns[task.status], task.id];
      }
    } else if (!existing) {
      // New task
      if (!newColumns[task.status].includes(task.id)) {
        newColumns[task.status] = [...newColumns[task.status], task.id];
      }
    }

    // Re-sort affected column
    newColumns[task.status].sort(
      (a, b) => (newTasksById[a]?.sortOrder ?? 0) - (newTasksById[b]?.sortOrder ?? 0)
    );

    set({ columns: newColumns, tasksById: newTasksById });
  },

  removeTask: (taskId) => {
    const state = get();
    const task = state.tasksById[taskId];
    if (!task) return;

    const newColumns = { ...state.columns };
    newColumns[task.status] = newColumns[task.status].filter((id) => id !== taskId);

    const { [taskId]: _, ...newTasksById } = state.tasksById;
    set({ columns: newColumns, tasksById: newTasksById });
  },
}));
```

---

## Step 4: Create the Execution Status Store

**File**: `src/lib/store/execution-store.ts`

```typescript
import { create } from 'zustand';
import type { ExecutionStatus } from '@/lib/types';

interface ExecutionState {
  id: string;
  status: ExecutionStatus;
  taskId: string;
}

interface ExecutionStore {
  /** execution_id -> { status, taskId } */
  executions: Record<string, ExecutionState>;

  /** Update a single execution status (from board SSE) */
  updateExecution: (id: string, status: ExecutionStatus, taskId: string) => void;

  /** Get active execution for a task (if any) */
  getActiveExecution: (taskId: string) => ExecutionState | undefined;
}

export const useExecutionStore = create<ExecutionStore>((set, get) => ({
  executions: {},

  updateExecution: (id, status, taskId) => {
    set((state) => ({
      executions: { ...state.executions, [id]: { id, status, taskId } },
    }));
  },

  getActiveExecution: (taskId) => {
    return Object.values(get().executions).find(
      (e) => e.taskId === taskId && ['running', 'queued', 'cancelling'].includes(e.status)
    );
  },
}));
```

---

## Step 5: Create the Board SSE Hook

**File**: `src/lib/hooks/use-board-sse.ts`

```typescript
'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { useExecutionStore } from '@/lib/store/execution-store';

/** Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s */
function getBackoff(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 30_000);
}

/**
 * Subscribe to /api/sse/board for live board updates.
 * Merges server events into the Zustand stores.
 * Reconnects with exponential backoff on disconnect.
 */
export function useBoardSse() {
  const applyServerUpdate = useTaskBoardStore((s) => s.applyServerUpdate);
  const removeTask = useTaskBoardStore((s) => s.removeTask);
  const updateExecution = useExecutionStore((s) => s.updateExecution);
  const attemptRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const es = new EventSource('/api/sse/board');
    esRef.current = es;

    es.onopen = () => {
      attemptRef.current = 0; // Reset backoff on successful connection
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case 'task_updated':
          case 'task_created':
            applyServerUpdate(data.task);
            break;
          case 'task_deleted':
            removeTask(data.taskId);
            break;
          case 'execution_status':
            updateExecution(data.executionId, data.status, data.taskId);
            break;
          case 'heartbeat':
            // Keep-alive, no action
            break;
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;

      // Reconnect with exponential backoff
      const delay = getBackoff(attemptRef.current);
      attemptRef.current += 1;

      setTimeout(() => {
        connect();
      }, delay);
    };
  }, [applyServerUpdate, removeTask, updateExecution]);

  useEffect(() => {
    connect();

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [connect]);
}
```

---

## Step 6: Upgrade Task Board for Drag-and-Drop

### 6.1 Update task-board.tsx with DndContext

**File**: `src/components/tasks/task-board.tsx` (modify existing)

```typescript
'use client';

import { useEffect, useCallback, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useTaskBoardStore } from '@/lib/store/task-board-store';
import { useBoardSse } from '@/lib/hooks/use-board-sse';
import { TaskColumn } from './task-column';
import { TaskCard } from './task-card';
import type { TaskStatus, Task } from '@/lib/types';

interface TaskBoardProps {
  initialTasks: Task[];
}

const STATUSES: TaskStatus[] = [
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
];

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function TaskBoard({ initialTasks }: TaskBoardProps) {
  const hydrate = useTaskBoardStore((s) => s.hydrate);
  const columns = useTaskBoardStore((s) => s.columns);
  const tasksById = useTaskBoardStore((s) => s.tasksById);
  const moveTask = useTaskBoardStore((s) => s.moveTask);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [overColumnId, setOverColumnId] = useState<TaskStatus | null>(null);

  // Subscribe to live board updates
  useBoardSse();

  // Hydrate store from RSC props on mount
  useEffect(() => {
    hydrate(initialTasks);
  }, [hydrate, initialTasks]);

  // DnD sensors: pointer + keyboard for accessibility
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 }, // 8px drag threshold
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const overId = event.over?.id as string | undefined;
    if (!overId) {
      setOverColumnId(null);
      return;
    }

    // Determine if hovering over a column or a card
    if (STATUSES.includes(overId as TaskStatus)) {
      setOverColumnId(overId as TaskStatus);
    } else {
      // Hovering over a card: find which column it belongs to
      const task = tasksById[overId];
      if (task) {
        setOverColumnId(task.status);
      }
    }
  }, [tasksById]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveId(null);
      setOverColumnId(null);

      if (!over) return;

      const taskId = active.id as string;
      const task = tasksById[taskId];
      if (!task) return;

      const fromStatus = task.status;

      // Determine target status and index
      let toStatus: TaskStatus;
      let newIndex: number;

      if (STATUSES.includes(over.id as TaskStatus)) {
        // Dropped on a column (empty area)
        toStatus = over.id as TaskStatus;
        newIndex = columns[toStatus].length; // Append to end
      } else {
        // Dropped on a card
        const overTask = tasksById[over.id as string];
        if (!overTask) return;
        toStatus = overTask.status;
        newIndex = columns[toStatus].indexOf(over.id as string);
      }

      // Skip if position unchanged
      if (fromStatus === toStatus) {
        const currentIndex = columns[fromStatus].indexOf(taskId);
        if (currentIndex === newIndex) return;
      }

      await moveTask(taskId, fromStatus, toStatus, newIndex);
    },
    [tasksById, columns, moveTask],
  );

  const activeTask = activeId ? tasksById[activeId] : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-4 overflow-x-auto pb-4 min-h-[calc(100vh-8rem)]">
        {STATUSES.map((status) => (
          <TaskColumn
            key={status}
            status={status}
            label={STATUS_LABELS[status]}
            taskIds={columns[status]}
            tasksById={tasksById}
            isOver={overColumnId === status}
          />
        ))}
      </div>

      {/* Floating drag overlay - renders the card being dragged */}
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <TaskCard
            task={activeTask}
            isDragOverlay
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
```

### 6.2 Update task-column.tsx with useDroppable

**File**: `src/components/tasks/task-column.tsx` (modify existing)

```typescript
'use client';

import { useDroppable } from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { TaskCard } from './task-card';
import { TaskQuickAdd } from './task-quick-add';
import { Badge } from '@/components/ui/badge';
import type { TaskStatus } from '@/lib/types';

interface TaskColumnProps {
  status: TaskStatus;
  label: string;
  taskIds: string[];
  tasksById: Record<string, any>;
  isOver: boolean;
}

export function TaskColumn({
  status,
  label,
  taskIds,
  tasksById,
  isOver,
}: TaskColumnProps) {
  const { setNodeRef, isOver: isDirectlyOver } = useDroppable({
    id: status,
  });

  return (
    <div
      ref={setNodeRef}
      className={`
        flex flex-col min-w-[280px] w-[320px] rounded-lg bg-muted/50
        ${isOver || isDirectlyOver ? 'ring-2 ring-primary/50 bg-primary/5' : ''}
        transition-colors duration-200
      `}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <h3 className="text-sm font-medium">{label}</h3>
        <Badge variant="secondary" className="text-xs">
          {taskIds.length}
        </Badge>
      </div>

      {/* Sortable card list */}
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {taskIds.map((id) => {
            const task = tasksById[id];
            if (!task) return null;
            return <TaskCard key={id} task={task} />;
          })}

          {/* Empty state */}
          {taskIds.length === 0 && (
            <div className="flex items-center justify-center h-24 text-sm text-muted-foreground border border-dashed rounded-md">
              Drop tasks here
            </div>
          )}
        </div>
      </SortableContext>

      {/* Quick add at bottom */}
      <TaskQuickAdd status={status} />
    </div>
  );
}
```

### 6.3 Update task-card.tsx with useSortable

**File**: `src/components/tasks/task-card.tsx` (modify existing)

```typescript
'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useExecutionStore } from '@/lib/store/execution-store';
import type { TaskStatus } from '@/lib/types';

interface TaskCardProps {
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    priority: number;
    assigneeAgentId: string | null;
  };
  isDragOverlay?: boolean;
  onClick?: () => void;
}

const PRIORITY_LABELS: Record<number, { label: string; className: string }> = {
  1: { label: 'Critical', className: 'bg-red-500/10 text-red-500' },
  2: { label: 'High', className: 'bg-orange-500/10 text-orange-500' },
  3: { label: 'Medium', className: 'bg-yellow-500/10 text-yellow-500' },
  4: { label: 'Low', className: 'bg-blue-500/10 text-blue-500' },
};

export function TaskCard({ task, isDragOverlay, onClick }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    disabled: isDragOverlay,
  });

  const activeExecution = useExecutionStore((s) => s.getActiveExecution(task.id));
  const priorityInfo = PRIORITY_LABELS[task.priority] ?? PRIORITY_LABELS[3];

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        group relative rounded-md border bg-card p-3 cursor-pointer
        hover:border-primary/50 transition-colors
        ${isDragOverlay ? 'shadow-lg ring-2 ring-primary/30 rotate-2' : ''}
        ${isDragging ? 'invisible' : ''}
      `}
      onClick={onClick}
    >
      {/* Drag handle */}
      <button
        className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing transition-opacity"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical className="h-4 w-4 text-muted-foreground" />
      </button>

      <div className="ml-4">
        {/* Title */}
        <p className="text-sm font-medium leading-tight line-clamp-2">
          {task.title}
        </p>

        {/* Meta row */}
        <div className="flex items-center gap-2 mt-2">
          <Badge variant="outline" className={`text-xs ${priorityInfo.className}`}>
            {priorityInfo.label}
          </Badge>

          {task.assigneeAgentId && (
            <Badge variant="secondary" className="text-xs">
              {task.assigneeAgentId}
            </Badge>
          )}

          {/* Execution indicator */}
          {activeExecution && (
            <span className="flex items-center gap-1 text-xs text-green-500">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              {activeExecution.status}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
```

---

## Step 7: Wire the Tasks Page

### 7.1 Update tasks/page.tsx

**File**: `src/app/(dashboard)/tasks/page.tsx` (modify existing)

Ensure the RSC page fetches initial board data and passes it to the client TaskBoard component. The board SSE hook handles live updates after hydration.

```typescript
import { db } from '@/lib/db';
import { tasks } from '@/lib/db/schema';
import { asc } from 'drizzle-orm';
import { TaskBoard } from '@/components/tasks/task-board';

export default async function TasksPage() {
  const allTasks = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      sortOrder: tasks.sortOrder,
      assigneeAgentId: tasks.assigneeAgentId,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .orderBy(asc(tasks.sortOrder));

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">Tasks</h1>
      <TaskBoard initialTasks={allTasks} />
    </div>
  );
}
```

---

## Testing Checklist

### Unit Tests

- [ ] **`sort-order.ts` -- computeSortOrder**
  - `computeSortOrder(null, null)` returns `SORT_ORDER_GAP` (1000)
  - `computeSortOrder(null, 500)` returns `250` (half of before)
  - `computeSortOrder(500, null)` returns `1500` (after + gap)
  - `computeSortOrder(500, 600)` returns `550` (midpoint)
  - `computeSortOrder(500, 501)` returns `500` (integer floor, gap < 1 triggers reindex)

- [ ] **`sort-order.ts` -- needsReindex**
  - Returns `true` when `newSortOrder - afterSortOrder < 1`
  - Returns `true` when `beforeSortOrder - newSortOrder < 1`
  - Returns `false` when gap is >= 1 on both sides

- [ ] **`task-board-store.ts` -- moveTask optimistic + rollback**
  - Moving task from `todo` to `in_progress` updates both columns immediately
  - On server failure (mocked fetch), state rolls back to snapshot
  - Toast is shown on rollback

- [ ] **`task-board-store.ts` -- applyServerUpdate**
  - New task is added to correct column
  - Task with changed status is moved between columns
  - Column is re-sorted by sortOrder after update

### Integration Tests

- [ ] **Within-column reorder**: POST `/api/tasks/[id]/reorder` with same status, verify `sort_order` updated correctly in DB
- [ ] **Cross-column move**: POST `/api/tasks/[id]/reorder` with different status, verify both `status` and `sort_order` updated
- [ ] **Reindex trigger**: Insert tasks with collapsing sort_orders, verify reindex assigns fresh gaps (multiples of 1000)
- [ ] **SSE board endpoint**: Connect to `/api/sse/board`, create a task via API, verify SSE event received with correct task data within 2s

---

## Verification

After completing all steps:

1. **Drag within column**: Drag a card up/down within "To Do" -- card stays at new position after page refresh
2. **Drag across columns**: Drag a card from "To Do" to "In Progress" -- card appears in new column, task status updated in DB
3. **Optimistic rollback**: Temporarily break the reorder API (return 500), drag a card -- card snaps back to original position, toast shows error
4. **DragOverlay**: While dragging, a floating semi-transparent copy of the card follows the cursor, rotated slightly
5. **Keyboard DnD**: Focus a card, press Space to pick up, arrow keys to move, Space to drop
6. **SSE live updates**: Open board in two browser tabs, create a task in tab 1 -- it appears in tab 2 within 2 seconds
7. **Execution indicator**: Start an execution for a task -- the card shows a pulsing green dot with "running" label
8. **Column highlight**: Drag a card over a column -- the column gets a subtle ring highlight
9. **Empty column**: Drag all cards out of a column -- "Drop tasks here" placeholder appears
