'use client';

import { create } from 'zustand';
import type { Task, TaskStatus, Project } from '@/lib/types';

/** All valid Kanban column statuses in display order */
export const BOARD_COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];

interface TaskBoardState {
  /** Normalized task lookup by ID */
  tasksById: Record<string, Task>;

  /** Ordered task IDs per status column */
  columns: Record<TaskStatus, string[]>;

  /** Cursor for pagination per column (null = no more pages) */
  cursors: Record<TaskStatus, string | null>;

  /** Loading state per column */
  loading: Record<TaskStatus, boolean>;

  /** Currently selected task ID (for detail sheet) */
  selectedTaskId: string | null;

  /** Task IDs with pending optimistic updates (skip SSE overwrite) */
  pendingOptimistic: Set<string>;

  /** Project lookup by ID */
  projectsById: Record<string, Project>;

  /** Project IDs to show (empty = show all) */
  selectedProjectIds: string[];
}

interface TaskBoardActions {
  /** Hydrate the store from server-fetched data (called once from RSC wrapper) */
  hydrate: (
    tasksByStatus: Record<TaskStatus, Task[]>,
    cursors: Record<TaskStatus, string | null>,
  ) => void;

  /** Append more tasks to a column (from "Load More" pagination) */
  appendToColumn: (status: TaskStatus, tasks: Task[], nextCursor: string | null) => void;

  /** Update a single task in the store (after server action response) */
  updateTask: (task: Task) => void;

  /** Add a new task to the appropriate column */
  addTask: (task: Task) => void;

  /** Remove a task from the store */
  removeTask: (taskId: string) => void;

  /**
   * Move a task between columns (status change).
   * In Phase 3, this is called AFTER the server action succeeds.
   */
  moveTask: (taskId: string, newStatus: TaskStatus) => void;

  /** Select a task (opens detail sheet) */
  selectTask: (taskId: string | null) => void;

  /** Set loading state for a column */
  setColumnLoading: (status: TaskStatus, loading: boolean) => void;

  /** Optimistically reorder a task within/between columns */
  optimisticReorder: (taskId: string, newStatus: TaskStatus, newIndex: number) => void;

  /** Apply a server-sent task update (skips if task has pending optimistic) */
  applyServerUpdate: (task: Task) => void;

  /** Apply a server-sent new task creation */
  applyServerCreate: (task: Task) => void;

  /** Clear the optimistic flag for a task (after server confirms) */
  settleOptimistic: (taskId: string) => void;

  /** Populate the projects lookup from an array */
  hydrateProjects: (projects: Project[]) => void;

  /** Set which project IDs are selected for filtering (empty = all) */
  setProjectFilter: (projectIds: string[]) => void;
}

type TaskBoardStore = TaskBoardState & TaskBoardActions;

function createEmptyColumns(): Record<TaskStatus, string[]> {
  return {
    todo: [],
    in_progress: [],
    blocked: [],
    done: [],
    cancelled: [],
  };
}

function createEmptyCursors(): Record<TaskStatus, string | null> {
  return {
    todo: null,
    in_progress: null,
    blocked: null,
    done: null,
    cancelled: null,
  };
}

function createEmptyLoading(): Record<TaskStatus, boolean> {
  return {
    todo: false,
    in_progress: false,
    blocked: false,
    done: false,
    cancelled: false,
  };
}

export const useTaskBoardStore = create<TaskBoardStore>((set, get) => ({
  tasksById: {},
  columns: createEmptyColumns(),
  cursors: createEmptyCursors(),
  loading: createEmptyLoading(),
  selectedTaskId: null,
  pendingOptimistic: new Set(),
  projectsById: {},
  selectedProjectIds: [],

  hydrate: (tasksByStatus, cursors) => {
    const tasksById: Record<string, Task> = {};
    const columns = createEmptyColumns();

    for (const status of BOARD_COLUMNS) {
      const statusTasks = tasksByStatus[status] ?? [];
      for (const task of statusTasks) {
        tasksById[task.id] = task;
        columns[status].push(task.id);
      }
    }

    set({ tasksById, columns, cursors });
  },

  appendToColumn: (status, tasks, nextCursor) => {
    set((state) => {
      const newTasksById = { ...state.tasksById };
      const newColumn = [...state.columns[status]];

      for (const task of tasks) {
        newTasksById[task.id] = task;
        newColumn.push(task.id);
      }

      return {
        tasksById: newTasksById,
        columns: { ...state.columns, [status]: newColumn },
        cursors: { ...state.cursors, [status]: nextCursor },
      };
    });
  },

  updateTask: (task) => {
    set((state) => {
      const oldTask = state.tasksById[task.id];
      const newTasksById = { ...state.tasksById, [task.id]: task };

      if (oldTask && oldTask.status !== task.status) {
        const oldColumn = state.columns[oldTask.status].filter((id) => id !== task.id);
        const newColumn = [...state.columns[task.status], task.id];

        return {
          tasksById: newTasksById,
          columns: {
            ...state.columns,
            [oldTask.status]: oldColumn,
            [task.status]: newColumn,
          },
        };
      }

      return { tasksById: newTasksById };
    });
  },

  addTask: (task) => {
    set((state) => ({
      tasksById: { ...state.tasksById, [task.id]: task },
      columns: {
        ...state.columns,
        [task.status]: [...state.columns[task.status], task.id],
      },
    }));
  },

  removeTask: (taskId) => {
    set((state) => {
      const task = state.tasksById[taskId];
      if (!task) return state;

      const { [taskId]: _, ...newTasksById } = state.tasksById;
      const newColumn = state.columns[task.status].filter((id) => id !== taskId);

      return {
        tasksById: newTasksById,
        columns: { ...state.columns, [task.status]: newColumn },
        selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
      };
    });
  },

  moveTask: (taskId, newStatus) => {
    set((state) => {
      const task = state.tasksById[taskId];
      if (!task || task.status === newStatus) return state;

      const oldColumn = state.columns[task.status].filter((id) => id !== taskId);
      const newColumn = [...state.columns[newStatus], taskId];

      return {
        tasksById: {
          ...state.tasksById,
          [taskId]: { ...task, status: newStatus },
        },
        columns: {
          ...state.columns,
          [task.status]: oldColumn,
          [newStatus]: newColumn,
        },
      };
    });
  },

  selectTask: (taskId) => set({ selectedTaskId: taskId }),

  setColumnLoading: (status, loading) =>
    set((state) => ({
      loading: { ...state.loading, [status]: loading },
    })),

  optimisticReorder: (taskId, newStatus, newIndex) => {
    set((state) => {
      const task = state.tasksById[taskId];
      if (!task) return state;

      const oldStatus = task.status;
      const newPending = new Set(state.pendingOptimistic);
      newPending.add(taskId);

      // Remove from old column
      const oldColumn = state.columns[oldStatus].filter((id) => id !== taskId);

      // Insert into new column at position
      const targetColumn = oldStatus === newStatus ? oldColumn : [...state.columns[newStatus]];
      const insertColumn = [...targetColumn];
      insertColumn.splice(newIndex, 0, taskId);

      return {
        tasksById: {
          ...state.tasksById,
          [taskId]: { ...task, status: newStatus },
        },
        columns: {
          ...state.columns,
          [oldStatus]: oldStatus === newStatus ? insertColumn : oldColumn,
          ...(oldStatus !== newStatus ? { [newStatus]: insertColumn } : {}),
        },
        pendingOptimistic: newPending,
      };
    });
  },

  applyServerUpdate: (task) => {
    const state = get();
    // Skip SSE overwrite if we have a pending optimistic update
    if (state.pendingOptimistic.has(task.id)) return;

    set((prev) => {
      const oldTask = prev.tasksById[task.id];
      if (!oldTask) {
        // New task from SSE: add it
        return {
          tasksById: { ...prev.tasksById, [task.id]: task },
          columns: {
            ...prev.columns,
            [task.status]: [...prev.columns[task.status], task.id],
          },
        };
      }

      const newTasksById = { ...prev.tasksById, [task.id]: task };

      if (oldTask.status !== task.status) {
        const oldColumn = prev.columns[oldTask.status].filter((id) => id !== task.id);
        const newColumn = [...prev.columns[task.status], task.id];
        return {
          tasksById: newTasksById,
          columns: {
            ...prev.columns,
            [oldTask.status]: oldColumn,
            [task.status]: newColumn,
          },
        };
      }

      return { tasksById: newTasksById };
    });
  },

  applyServerCreate: (task) => {
    set((state) => {
      if (state.tasksById[task.id]) return state;
      return {
        tasksById: { ...state.tasksById, [task.id]: task },
        columns: {
          ...state.columns,
          [task.status]: [...state.columns[task.status], task.id],
        },
      };
    });
  },

  settleOptimistic: (taskId) => {
    set((state) => {
      const newPending = new Set(state.pendingOptimistic);
      newPending.delete(taskId);
      return { pendingOptimistic: newPending };
    });
  },

  hydrateProjects: (projectList) => {
    const projectsById: Record<string, Project> = {};
    for (const project of projectList) {
      projectsById[project.id] = project;
    }
    set({ projectsById });
  },

  setProjectFilter: (projectIds) => {
    set({ selectedProjectIds: projectIds });
  },
}));
