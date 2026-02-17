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
});
