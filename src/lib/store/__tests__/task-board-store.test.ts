import { describe, it, expect, beforeEach } from 'vitest';
import type { Task, TaskStatus } from '@/lib/types';

// Create a mock task factory
function createMockTask(overrides: Partial<Task> & { id: string; status: TaskStatus }): Task {
  return {
    ownerId: '00000000-0000-0000-0000-000000000001',
    workspaceId: '00000000-0000-0000-0000-000000000001',
    parentTaskId: null,
    title: `Task ${overrides.id}`,
    description: null,
    priority: 3,
    sortOrder: 1000,
    assigneeAgentId: null,
    inputContext: {},
    dueAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Import the store - Zustand stores work fine outside React
import { useTaskBoardStore } from '../task-board-store';

describe('task-board-store', () => {
  beforeEach(() => {
    // Reset the store between tests
    useTaskBoardStore.setState({
      tasksById: {},
      columns: {
        todo: [],
        in_progress: [],
        blocked: [],
        done: [],
        cancelled: [],
      },
      cursors: {
        todo: null,
        in_progress: null,
        blocked: null,
        done: null,
        cancelled: null,
      },
      loading: {
        todo: false,
        in_progress: false,
        blocked: false,
        done: false,
        cancelled: false,
      },
      selectedTaskId: null,
      pendingOptimistic: new Set(),
    });
  });

  describe('hydrate', () => {
    it('populates columns with correct task IDs in each status column', () => {
      const todoTask = createMockTask({ id: 'task-1', status: 'todo' });
      const ipTask = createMockTask({ id: 'task-2', status: 'in_progress' });
      const doneTask = createMockTask({ id: 'task-3', status: 'done' });

      const tasksByStatus: Record<TaskStatus, Task[]> = {
        todo: [todoTask],
        in_progress: [ipTask],
        blocked: [],
        done: [doneTask],
        cancelled: [],
      };

      const cursors: Record<TaskStatus, string | null> = {
        todo: null,
        in_progress: null,
        blocked: null,
        done: null,
        cancelled: null,
      };

      useTaskBoardStore.getState().hydrate(tasksByStatus, cursors);

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual(['task-1']);
      expect(state.columns.in_progress).toEqual(['task-2']);
      expect(state.columns.done).toEqual(['task-3']);
      expect(state.columns.blocked).toEqual([]);
      expect(state.columns.cancelled).toEqual([]);

      // Verify tasksById is populated
      expect(state.tasksById['task-1']).toEqual(todoTask);
      expect(state.tasksById['task-2']).toEqual(ipTask);
      expect(state.tasksById['task-3']).toEqual(doneTask);
    });
  });

  describe('addTask', () => {
    it('appends new task to the correct status column', () => {
      const newTask = createMockTask({ id: 'new-task', status: 'todo' });

      useTaskBoardStore.getState().addTask(newTask);

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toContain('new-task');
      expect(state.tasksById['new-task']).toEqual(newTask);
    });

    it('appends to end of existing column', () => {
      const task1 = createMockTask({ id: 'task-1', status: 'todo' });
      const task2 = createMockTask({ id: 'task-2', status: 'todo' });

      useTaskBoardStore.getState().addTask(task1);
      useTaskBoardStore.getState().addTask(task2);

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual(['task-1', 'task-2']);
    });
  });

  describe('moveTask', () => {
    it('removes task from old column and adds to new column', () => {
      const task = createMockTask({ id: 'task-1', status: 'todo' });

      // Add task first
      useTaskBoardStore.getState().addTask(task);
      expect(useTaskBoardStore.getState().columns.todo).toEqual(['task-1']);

      // Move it
      useTaskBoardStore.getState().moveTask('task-1', 'in_progress');

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual([]);
      expect(state.columns.in_progress).toContain('task-1');
      expect(state.tasksById['task-1'].status).toBe('in_progress');
    });

    it('does nothing when moving to same status', () => {
      const task = createMockTask({ id: 'task-1', status: 'todo' });
      useTaskBoardStore.getState().addTask(task);

      useTaskBoardStore.getState().moveTask('task-1', 'todo');

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual(['task-1']);
    });
  });

  describe('removeTask', () => {
    it('clears selectedTaskId if the removed task was selected', () => {
      const task = createMockTask({ id: 'task-1', status: 'todo' });

      useTaskBoardStore.getState().addTask(task);
      useTaskBoardStore.getState().selectTask('task-1');
      expect(useTaskBoardStore.getState().selectedTaskId).toBe('task-1');

      useTaskBoardStore.getState().removeTask('task-1');

      const state = useTaskBoardStore.getState();
      expect(state.selectedTaskId).toBeNull();
      expect(state.columns.todo).toEqual([]);
      expect(state.tasksById['task-1']).toBeUndefined();
    });

    it('does not clear selectedTaskId if a different task is removed', () => {
      const task1 = createMockTask({ id: 'task-1', status: 'todo' });
      const task2 = createMockTask({ id: 'task-2', status: 'todo' });

      useTaskBoardStore.getState().addTask(task1);
      useTaskBoardStore.getState().addTask(task2);
      useTaskBoardStore.getState().selectTask('task-1');

      useTaskBoardStore.getState().removeTask('task-2');

      const state = useTaskBoardStore.getState();
      expect(state.selectedTaskId).toBe('task-1');
    });
  });

  describe('updateTask', () => {
    it('moves task between columns when status changes', () => {
      const task = createMockTask({ id: 'task-1', status: 'todo' });
      useTaskBoardStore.getState().addTask(task);

      const updatedTask = { ...task, status: 'in_progress' as const };
      useTaskBoardStore.getState().updateTask(updatedTask);

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual([]);
      expect(state.columns.in_progress).toContain('task-1');
      expect(state.tasksById['task-1'].status).toBe('in_progress');
    });

    it('updates task data without moving when status is unchanged', () => {
      const task = createMockTask({ id: 'task-1', status: 'todo', title: 'Old Title' });
      useTaskBoardStore.getState().addTask(task);

      const updatedTask = { ...task, title: 'New Title' };
      useTaskBoardStore.getState().updateTask(updatedTask);

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual(['task-1']);
      expect(state.tasksById['task-1'].title).toBe('New Title');
    });
  });

  describe('optimisticReorder', () => {
    it('moves a task within the same column to the specified index', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo' });
      const t2 = createMockTask({ id: 'task-2', status: 'todo' });
      const t3 = createMockTask({ id: 'task-3', status: 'todo' });
      useTaskBoardStore.getState().addTask(t1);
      useTaskBoardStore.getState().addTask(t2);
      useTaskBoardStore.getState().addTask(t3);

      // Move task-1 to index 2 (end of column)
      useTaskBoardStore.getState().optimisticReorder('task-1', 'todo', 2);

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual(['task-2', 'task-3', 'task-1']);
    });

    it('moves a task between columns', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo' });
      const t2 = createMockTask({ id: 'task-2', status: 'in_progress' });
      useTaskBoardStore.getState().addTask(t1);
      useTaskBoardStore.getState().addTask(t2);

      useTaskBoardStore.getState().optimisticReorder('task-1', 'in_progress', 0);

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual([]);
      expect(state.columns.in_progress).toContain('task-1');
      expect(state.tasksById['task-1'].status).toBe('in_progress');
    });

    it('inserts at the correct index when moving to another column', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo' });
      const t2 = createMockTask({ id: 'task-2', status: 'in_progress' });
      const t3 = createMockTask({ id: 'task-3', status: 'in_progress' });
      useTaskBoardStore.getState().addTask(t1);
      useTaskBoardStore.getState().addTask(t2);
      useTaskBoardStore.getState().addTask(t3);

      // Move task-1 to in_progress at index 1 (between task-2 and task-3)
      useTaskBoardStore.getState().optimisticReorder('task-1', 'in_progress', 1);

      const state = useTaskBoardStore.getState();
      expect(state.columns.in_progress).toEqual(['task-2', 'task-1', 'task-3']);
    });

    it('adds taskId to pendingOptimistic', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo' });
      useTaskBoardStore.getState().addTask(t1);

      useTaskBoardStore.getState().optimisticReorder('task-1', 'todo', 0);

      const state = useTaskBoardStore.getState();
      expect(state.pendingOptimistic.has('task-1')).toBe(true);
    });

    it('does nothing when taskId does not exist', () => {
      const stateBefore = useTaskBoardStore.getState();

      useTaskBoardStore.getState().optimisticReorder('non-existent', 'todo', 0);

      const stateAfter = useTaskBoardStore.getState();
      expect(stateAfter.columns.todo).toEqual(stateBefore.columns.todo);
    });
  });

  describe('applyServerUpdate', () => {
    it('skips tasks that have a pending optimistic update', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo', title: 'Original' });
      useTaskBoardStore.getState().addTask(t1);
      // Mark as pending
      useTaskBoardStore.getState().optimisticReorder('task-1', 'todo', 0);

      const serverVersion = { ...t1, title: 'Server Title', status: 'in_progress' as const };
      useTaskBoardStore.getState().applyServerUpdate(serverVersion);

      // Task should NOT have been updated because it's pending
      const state = useTaskBoardStore.getState();
      expect(state.tasksById['task-1'].title).toBe('Original');
      expect(state.tasksById['task-1'].status).toBe('todo');
    });

    it('updates task data when task is not pending', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo', title: 'Original' });
      useTaskBoardStore.getState().addTask(t1);

      const serverVersion = { ...t1, title: 'Server Title' };
      useTaskBoardStore.getState().applyServerUpdate(serverVersion);

      const state = useTaskBoardStore.getState();
      expect(state.tasksById['task-1'].title).toBe('Server Title');
    });

    it('handles cross-column move from server update', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo' });
      useTaskBoardStore.getState().addTask(t1);

      const serverVersion = { ...t1, status: 'in_progress' as const };
      useTaskBoardStore.getState().applyServerUpdate(serverVersion);

      const state = useTaskBoardStore.getState();
      expect(state.columns.todo).toEqual([]);
      expect(state.columns.in_progress).toContain('task-1');
      expect(state.tasksById['task-1'].status).toBe('in_progress');
    });

    it('adds task as new when task id is not in the store', () => {
      const newTask = createMockTask({ id: 'task-new', status: 'blocked' });

      useTaskBoardStore.getState().applyServerUpdate(newTask);

      const state = useTaskBoardStore.getState();
      expect(state.tasksById['task-new']).toEqual(newTask);
      expect(state.columns.blocked).toContain('task-new');
    });
  });

  describe('applyServerCreate', () => {
    it('adds a new task that does not exist in the store', () => {
      const newTask = createMockTask({ id: 'task-created', status: 'todo' });

      useTaskBoardStore.getState().applyServerCreate(newTask);

      const state = useTaskBoardStore.getState();
      expect(state.tasksById['task-created']).toEqual(newTask);
      expect(state.columns.todo).toContain('task-created');
    });

    it('ignores creation when task id already exists (duplicate)', () => {
      const existing = createMockTask({ id: 'task-dup', status: 'todo', title: 'Existing' });
      useTaskBoardStore.getState().addTask(existing);

      const duplicate = { ...existing, title: 'Duplicate' };
      useTaskBoardStore.getState().applyServerCreate(duplicate);

      const state = useTaskBoardStore.getState();
      // Title must remain unchanged
      expect(state.tasksById['task-dup'].title).toBe('Existing');
      // Column must not contain the id twice
      expect(state.columns.todo.filter((id) => id === 'task-dup')).toHaveLength(1);
    });
  });

  describe('settleOptimistic', () => {
    it('removes taskId from pendingOptimistic', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo' });
      useTaskBoardStore.getState().addTask(t1);
      useTaskBoardStore.getState().optimisticReorder('task-1', 'todo', 0);
      expect(useTaskBoardStore.getState().pendingOptimistic.has('task-1')).toBe(true);

      useTaskBoardStore.getState().settleOptimistic('task-1');

      expect(useTaskBoardStore.getState().pendingOptimistic.has('task-1')).toBe(false);
    });

    it('is a no-op for a taskId that is not pending', () => {
      useTaskBoardStore.getState().settleOptimistic('never-pending');

      const state = useTaskBoardStore.getState();
      expect(state.pendingOptimistic.size).toBe(0);
    });

    it('only removes the specified taskId, leaving others pending', () => {
      const t1 = createMockTask({ id: 'task-1', status: 'todo' });
      const t2 = createMockTask({ id: 'task-2', status: 'todo' });
      useTaskBoardStore.getState().addTask(t1);
      useTaskBoardStore.getState().addTask(t2);
      useTaskBoardStore.getState().optimisticReorder('task-1', 'todo', 0);
      useTaskBoardStore.getState().optimisticReorder('task-2', 'todo', 1);

      useTaskBoardStore.getState().settleOptimistic('task-1');

      const state = useTaskBoardStore.getState();
      expect(state.pendingOptimistic.has('task-1')).toBe(false);
      expect(state.pendingOptimistic.has('task-2')).toBe(true);
    });
  });
});
