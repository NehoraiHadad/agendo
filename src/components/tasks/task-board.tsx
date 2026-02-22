'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
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
import { useTaskBoardStore, BOARD_COLUMNS } from '@/lib/store/task-board-store';
import { TaskColumn } from './task-column';
import { TaskDetailSheet } from './task-detail-sheet';
import { TaskCreateDialog } from './task-create-dialog';
import { TaskDragOverlay } from './task-drag-overlay';
import { useBoardSse } from '@/hooks/use-board-sse';
import { toast } from 'sonner';
import type { TaskStatus, Project } from '@/lib/types';
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
function resolveColumnStatus(overId: string, tasksById: Record<string, TaskBoardItem>): TaskStatus | null {
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
  const hydrated = useRef(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const originalStatusRef = useRef<TaskStatus | null>(null);

  // Initialize SSE connection
  useBoardSse();

  useEffect(() => {
    if (!hydrated.current) {
      hydrate(initialData, initialCursors);
      hydrateProjects(initialProjects);
      hydrated.current = true;
    }
  }, [initialData, initialCursors, initialProjects, hydrate, hydrateProjects]);

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

      const activeTask = tasksById[String(active.id)];
      if (!activeTask) return;

      const overStatus = resolveColumnStatus(String(over.id), tasksById);
      if (!overStatus || overStatus === activeTask.status) return;

      // Moving between columns during drag (visual feedback)
      const overColumn = columns[overStatus];
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
    [tasksById, columns, optimisticReorder],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;

      if (!over) return;

      const taskId = String(active.id);
      const task = tasksById[taskId];
      if (!task) return;

      // Use the status captured at drag start (before optimistic updates modified tasksById)
      const originalStatus = originalStatusRef.current;
      originalStatusRef.current = null;

      const overStatus = resolveColumnStatus(String(over.id), tasksById);
      if (!overStatus) return;

      const column = columns[overStatus];
      const overIndex =
        over.id === `column-${overStatus}` ? column.length - 1 : column.indexOf(String(over.id));
      const finalIndex = overIndex >= 0 ? overIndex : column.length - 1;

      // Apply optimistic reorder (if not already applied by dragOver)
      optimisticReorder(taskId, overStatus, finalIndex);

      // Calculate sort order neighbors from the current column state
      const currentColumn = useTaskBoardStore.getState().columns[overStatus];
      const idx = currentColumn.indexOf(taskId);

      const afterTask = idx > 0 ? tasksById[currentColumn[idx - 1]] : null;
      const beforeTask = idx < currentColumn.length - 1 ? tasksById[currentColumn[idx + 1]] : null;

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
    [tasksById, columns, optimisticReorder, settleOptimistic],
  );

  const projects = Object.values(projectsById);
  const hasProjects = projects.length > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <TaskCreateDialog />
      </div>

      {hasProjects && (
        <div className="flex items-center gap-2 border-b border-white/[0.05] px-6 py-2">
          <button
            onClick={() => setProjectFilter([])}
            className={`rounded-full border px-3 py-0.5 text-xs transition-colors ${
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
                className={`flex items-center gap-1.5 rounded-full border px-3 py-0.5 text-xs transition-colors ${
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
        <div className="flex flex-1 gap-4 overflow-x-auto p-4">
          {BOARD_COLUMNS.map((status) => {
            const filteredTaskIds =
              selectedProjectIds.length === 0
                ? undefined
                : columns[status].filter(
                    (id) =>
                      tasksById[id]?.projectId != null &&
                      selectedProjectIds.includes(tasksById[id].projectId as string),
                  );
            return (
              <TaskColumn
                key={status}
                status={status}
                label={COLUMN_LABELS[status]}
                filteredTaskIds={filteredTaskIds}
              />
            );
          })}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeId ? <TaskDragOverlay taskId={activeId} /> : null}
        </DragOverlay>
      </DndContext>

      {selectedTaskId && <TaskDetailSheet key={selectedTaskId} taskId={selectedTaskId} />}
    </div>
  );
}
