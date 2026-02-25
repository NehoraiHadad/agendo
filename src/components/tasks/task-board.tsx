'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  DndContext,
  closestCorners,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { DragOverlay } from '@dnd-kit/core';
import { Ghost } from 'lucide-react';
import { useTaskBoardStore, BOARD_COLUMNS } from '@/lib/store/task-board-store';
import { TaskColumn } from './task-column';
import { TaskDetailSheet } from './task-detail-sheet';
import { TaskCreateDialog } from './task-create-dialog';
import { TaskDragOverlay } from './task-drag-overlay';
import { useBoardSse } from '@/hooks/use-board-sse';
import { toast } from 'sonner';
import type { TaskStatus, Project, Task } from '@/lib/types';
import type { TaskBoardItem } from '@/lib/services/task-service';

interface TaskBoardProps {
  initialData: Record<TaskStatus, TaskBoardItem[]>;
  initialCursors: Record<TaskStatus, string | null>;
  initialProjects: Project[];
}

const COLUMN_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Extract column status from a droppable id like "column-todo" or a task id */
function resolveColumnStatus(
  overId: string,
  tasksById: Record<string, TaskBoardItem>,
): TaskStatus | null {
  if (overId.startsWith('column-')) {
    return overId.replace('column-', '') as TaskStatus;
  }
  const task = tasksById[overId];
  return task ? task.status : null;
}

export function TaskBoard({ initialData, initialCursors, initialProjects }: TaskBoardProps) {
  const hydrate = useTaskBoardStore((s) => s.hydrate);
  const hydrateProjects = useTaskBoardStore((s) => s.hydrateProjects);
  const selectedTaskId = useTaskBoardStore((s) => s.selectedTaskId);
  const tasksById = useTaskBoardStore((s) => s.tasksById);
  const columns = useTaskBoardStore((s) => s.columns);
  const optimisticReorder = useTaskBoardStore((s) => s.optimisticReorder);
  const settleOptimistic = useTaskBoardStore((s) => s.settleOptimistic);
  const projectsById = useTaskBoardStore((s) => s.projectsById);
  const selectedProjectIds = useTaskBoardStore((s) => s.selectedProjectIds);
  const setProjectFilter = useTaskBoardStore((s) => s.setProjectFilter);
  const showAdHoc = useTaskBoardStore((s) => s.showAdHoc);
  const setShowAdHoc = useTaskBoardStore((s) => s.setShowAdHoc);
  const applyServerCreate = useTaskBoardStore((s) => s.applyServerCreate);
  const purgeAdHocTasks = useTaskBoardStore((s) => s.purgeAdHocTasks);
  const hydrated = useRef(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const originalStatusRef = useRef<TaskStatus | null>(null);
  const adHocLoadedRef = useRef(false);

  // Initialize SSE connection
  useBoardSse();

  useEffect(() => {
    if (!hydrated.current) {
      hydrate(initialData, initialCursors);
      hydrateProjects(initialProjects);
      hydrated.current = true;
    }
  }, [initialData, initialCursors, initialProjects, hydrate, hydrateProjects]);

  // Sync ad-hoc visibility: fetch on enable, purge on disable
  useEffect(() => {
    if (!showAdHoc) {
      purgeAdHocTasks();
      adHocLoadedRef.current = false;
      return;
    }

    if (adHocLoadedRef.current) return;
    adHocLoadedRef.current = true;

    async function fetchAdHoc() {
      try {
        const results = await Promise.all(
          BOARD_COLUMNS.map((status) =>
            fetch(`/api/tasks?status=${status}&includeAdHoc=true&limit=100`)
              .then((r) => r.json())
              .then((j) => (j.data as Task[]) ?? []),
          ),
        );
        for (const tasks of results) {
          for (const task of tasks) {
            if ((task as TaskBoardItem).isAdHoc) applyServerCreate(task);
          }
        }
      } catch {
        // silently ignore — ad-hoc view is best-effort
      }
    }

    void fetchAdHoc();
  }, [showAdHoc, applyServerCreate, purgeAdHocTasks]);

  const toggleProjectFilter = useCallback(
    (projectId: string) => {
      if (selectedProjectIds.includes(projectId)) {
        setProjectFilter(selectedProjectIds.filter((id) => id !== projectId));
      } else {
        setProjectFilter([...selectedProjectIds, projectId]);
      }
    },
    [selectedProjectIds, setProjectFilter],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const taskId = String(event.active.id);
    setActiveId(taskId);
    // Capture original status before any optimistic updates
    const task = useTaskBoardStore.getState().tasksById[taskId];
    originalStatusRef.current = task?.status ?? null;
  }, []);

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const { active, over } = event;
      if (!over) return;

      // Read fresh state via getState() — avoids stale closure without subscribing reactively
      const { tasksById: tbid, columns: cols } = useTaskBoardStore.getState();
      const activeTask = tbid[String(active.id)];
      if (!activeTask) return;

      const overStatus = resolveColumnStatus(String(over.id), tbid);
      if (!overStatus || overStatus === activeTask.status) return;

      // Moving between columns during drag (visual feedback)
      const overColumn = cols[overStatus];
      const overIndex =
        over.id === `column-${overStatus}`
          ? overColumn.length
          : overColumn.indexOf(String(over.id));

      optimisticReorder(
        String(active.id),
        overStatus,
        overIndex >= 0 ? overIndex : overColumn.length,
      );
    },
    [optimisticReorder],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;

      if (!over) return;

      const taskId = String(active.id);

      // Read fresh state via getState() — avoids stale closure without subscribing reactively
      const { tasksById: tbid, columns: cols } = useTaskBoardStore.getState();
      const task = tbid[taskId];
      if (!task) return;

      // Use the status captured at drag start (before optimistic updates modified tasksById)
      const originalStatus = originalStatusRef.current;
      originalStatusRef.current = null;

      const overStatus = resolveColumnStatus(String(over.id), tbid);
      if (!overStatus) return;

      const column = cols[overStatus];
      const overIndex =
        over.id === `column-${overStatus}` ? column.length - 1 : column.indexOf(String(over.id));
      const finalIndex = overIndex >= 0 ? overIndex : column.length - 1;

      // Apply optimistic reorder (if not already applied by dragOver)
      optimisticReorder(taskId, overStatus, finalIndex);

      // Calculate sort order neighbors from the current column state (post-optimistic)
      const currentColumn = useTaskBoardStore.getState().columns[overStatus];
      const idx = currentColumn.indexOf(taskId);

      const afterTask =
        idx > 0 ? useTaskBoardStore.getState().tasksById[currentColumn[idx - 1]] : null;
      const beforeTask =
        idx < currentColumn.length - 1
          ? useTaskBoardStore.getState().tasksById[currentColumn[idx + 1]]
          : null;

      const afterSortOrder = afterTask?.sortOrder ?? null;
      const beforeSortOrder = beforeTask?.sortOrder ?? null;

      try {
        const res = await fetch(`/api/tasks/${taskId}/reorder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: overStatus !== originalStatus ? overStatus : undefined,
            afterSortOrder,
            beforeSortOrder,
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error?.message ?? 'Reorder failed');
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to reorder task');
        // Revert: re-hydrate would be too heavy, just let SSE correct it
      } finally {
        settleOptimistic(taskId);
      }
    },
    [optimisticReorder, settleOptimistic],
  );

  const projects = Object.values(projectsById);
  const hasProjects = projects.length > 0;

  // Pre-compute filtered task IDs per column to avoid inline filter on every render
  const filteredColumnTaskIds = useMemo<Record<string, string[] | undefined>>(
    () =>
      Object.fromEntries(
        BOARD_COLUMNS.map((status) => [
          status,
          selectedProjectIds.length === 0
            ? undefined
            : columns[status].filter(
                (id) =>
                  tasksById[id]?.projectId != null &&
                  selectedProjectIds.includes(tasksById[id].projectId as string),
              ),
        ]),
      ),
    [columns, tasksById, selectedProjectIds],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3 sm:px-6 sm:py-4">
        <h1 className="text-xl font-semibold sm:text-2xl">Tasks</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAdHoc(!showAdHoc)}
            title={showAdHoc ? 'Hide ad-hoc tasks' : 'Show ad-hoc tasks (chat scratch tasks)'}
            className={`flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              showAdHoc
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                : 'border-white/[0.06] text-muted-foreground/50 hover:border-white/10 hover:text-muted-foreground'
            }`}
          >
            <Ghost className="h-3 w-3" />
            Ad-hoc
          </button>
          <TaskCreateDialog />
        </div>
      </div>

      {hasProjects && (
        <div className="flex items-center gap-2 border-b border-white/[0.05] overflow-x-auto px-4 py-2 sm:px-6 sm:flex-wrap">
          <button
            onClick={() => setProjectFilter([])}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs transition-colors min-h-[36px] ${
              selectedProjectIds.length === 0
                ? 'border-white/20 bg-white/10 text-foreground'
                : 'border-white/[0.06] text-muted-foreground/60 hover:border-white/10 hover:text-muted-foreground'
            }`}
          >
            All Projects
          </button>
          {projects.map((project) => {
            const isSelected = selectedProjectIds.includes(project.id);
            return (
              <button
                key={project.id}
                onClick={() => toggleProjectFilter(project.id)}
                className={`shrink-0 flex min-h-[36px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                  isSelected
                    ? 'border-white/20 bg-white/10 text-foreground'
                    : 'border-white/[0.06] text-muted-foreground/60 hover:border-white/10 hover:text-muted-foreground'
                }`}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: project.color ?? '#6366f1' }}
                />
                {project.name}
              </button>
            );
          })}
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-row flex-1 min-h-0 gap-3 p-3 overflow-x-auto sm:gap-4 sm:p-4">
          {BOARD_COLUMNS.map((status) => (
            <TaskColumn
              key={status}
              status={status}
              label={COLUMN_LABELS[status]}
              filteredTaskIds={filteredColumnTaskIds[status]}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeId ? <TaskDragOverlay taskId={activeId} /> : null}
        </DragOverlay>
      </DndContext>

      {selectedTaskId && <TaskDetailSheet key={selectedTaskId} taskId={selectedTaskId} />}
    </div>
  );
}
