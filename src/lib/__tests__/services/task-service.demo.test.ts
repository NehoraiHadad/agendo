/**
 * Phase 1, Agent A — demo mode shadows for task-service.
 *
 * Tests the demo shadow module directly (no env stubbing, no DB mock needed).
 * Also tests that the branch in task-service.ts fires before any DB access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, TaskStatus } from '@/lib/types';
import type {
  TaskBoardItem,
  TaskWithDetails,
  SearchTaskResult,
  SearchProgressNoteResult,
} from '@/lib/services/task-service';

// ---- Direct demo module tests -----------------------------------------------

describe('task-service.demo — shape parity', () => {
  it('getTaskById returns a valid Task shape', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.getTaskById('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    // Compile-time parity check
    const _: Task = result satisfies Task;
    expect(result.id).toBe('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(typeof result.title).toBe('string');
    expect(typeof result.status).toBe('string');
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.updatedAt).toBeInstanceOf(Date);
  });

  it('getTaskById throws NotFoundError for unknown id', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    await expect(demo.getTaskById('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('getTaskWithDetails returns TaskWithDetails shape', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.getTaskWithDetails('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    const _: TaskWithDetails = result satisfies TaskWithDetails;
    expect(typeof result.subtaskCount).toBe('number');
    expect(typeof result.completedSubtaskCount).toBe('number');
    expect(typeof result.dependencyCount).toBe('number');
    expect(typeof result.blockedByCount).toBe('number');
    // assignee can be null or { id, name, slug }
    if (result.assignee !== null) {
      expect(typeof result.assignee.id).toBe('string');
      expect(typeof result.assignee.name).toBe('string');
      expect(typeof result.assignee.slug).toBe('string');
    }
    // parentTask can be null or { id, title }
    if (result.parentTask !== null) {
      expect(typeof result.parentTask.id).toBe('string');
      expect(typeof result.parentTask.title).toBe('string');
    }
  });

  it('listTasksByStatus returns { tasks, nextCursor } with TaskBoardItem elements', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.listTasksByStatus({ status: 'todo' });
    expect(result).toHaveProperty('tasks');
    expect(result).toHaveProperty('nextCursor');
    expect(Array.isArray(result.tasks)).toBe(true);
    if (result.tasks.length > 0) {
      const item: TaskBoardItem = result.tasks[0] satisfies TaskBoardItem;
      expect(item.status).toBe('todo');
      expect(typeof item.subtaskTotal).toBe('number');
      expect(typeof item.subtaskDone).toBe('number');
    }
  });

  it('listTasksByStatus filters by status correctly', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    for (const status of ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as TaskStatus[]) {
      const { tasks: items } = await demo.listTasksByStatus({ status });
      expect(items.every((t) => t.status === status)).toBe(true);
    }
  });

  it('listTasksByStatus filters by projectId', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const projectId = '44444444-4444-4444-a444-444444444444';
    const { tasks: items } = await demo.listTasksByStatus({ projectId });
    expect(items.every((t) => t.projectId === projectId)).toBe(true);
  });

  it('listTasksByStatus q filter searches by title', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const { tasks: items } = await demo.listTasksByStatus({ q: 'MCP' });
    expect(items.length).toBeGreaterThan(0);
    items.forEach((t) => expect(t.title.toLowerCase()).toContain('mcp'));
  });

  it('listSubtasks returns TaskBoardItem[] for a parent task', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    // task 4001 is parent of 4002 and 4003 per our fixtures
    const result = await demo.listSubtasks('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(Array.isArray(result)).toBe(true);
    result.forEach((item: TaskBoardItem) => {
      expect(item.parentTaskId).toBe('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
      expect(typeof item.subtaskTotal).toBe('number');
    });
  });

  it('listTasksBoardItems returns TaskBoardItem[] (ignores conditions in demo mode)', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.listTasksBoardItems([]);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    result.forEach((item: TaskBoardItem) => {
      expect(typeof item.subtaskTotal).toBe('number');
      expect(typeof item.subtaskDone).toBe('number');
    });
  });

  it('searchTasks returns SearchTaskResult[] matching query', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.searchTasks('session');
    const _: SearchTaskResult[] = result satisfies SearchTaskResult[];
    result.forEach((r) => {
      expect(typeof r.id).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.status).toBe('string');
    });
  });

  it('searchTasks returns empty array for unknown query', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.searchTasks('zzznomatchzzz');
    expect(result).toEqual([]);
  });

  it('searchProgressNotes returns SearchProgressNoteResult[] shape', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.searchProgressNotes('MCP');
    const _: SearchProgressNoteResult[] = result satisfies SearchProgressNoteResult[];
    result.forEach((r) => {
      expect(typeof r.taskId).toBe('string');
      expect(typeof r.taskTitle).toBe('string');
      expect(typeof r.taskStatus).toBe('string');
      expect(typeof r.noteSnippet).toBe('string');
    });
  });

  it('listReadyTasks returns TaskBoardItem[] of todo tasks', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.listReadyTasks();
    result.forEach((item: TaskBoardItem) => {
      expect(item.status).toBe('todo');
    });
  });

  it('listReadyTasks filters by projectId', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const projectId = '55555555-5555-4555-a555-555555555555';
    const result = await demo.listReadyTasks(projectId);
    result.forEach((item) => {
      expect(item.projectId).toBe(projectId);
    });
  });

  it('reindexColumn is a no-op in demo mode (returns void)', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.reindexColumn('todo');
    expect(result).toBeUndefined();
  });

  it('setExecutionOrder returns void in demo mode', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.setExecutionOrder({
      taskIds: ['aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa'],
    });
    expect(result).toBeUndefined();
  });
});

// ---- Mutation stub tests ----------------------------------------------------

describe('task-service.demo — mutation stubs', () => {
  it('createTask returns a Task-shaped stub without persisting', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const input = { title: 'Demo created task', status: 'todo' as TaskStatus };
    const result = await demo.createTask(input);
    const _: Task = result satisfies Task;
    expect(result.title).toBe('Demo created task');
    expect(result.status).toBe('todo');
    expect(typeof result.id).toBe('string');
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('createTask two calls produce different IDs', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const a = await demo.createTask({ title: 'A' });
    const b = await demo.createTask({ title: 'B' });
    expect(a.id).not.toBe(b.id);
  });

  it('updateTask returns merged Task shape', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.updateTask('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa', {
      title: 'Updated title',
    });
    const _: Task = result satisfies Task;
    expect(result.title).toBe('Updated title');
    expect(result.id).toBe('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
  });

  it('updateTask throws for unknown id', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    await expect(
      demo.updateTask('00000000-0000-0000-0000-000000000000', { title: 'x' }),
    ).rejects.toThrow();
  });

  it('deleteTask returns void without errors', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.deleteTask('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(result).toBeUndefined();
  });

  it('reorderTask returns a valid Task shape', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const result = await demo.reorderTask('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa', {
      afterSortOrder: null,
      beforeSortOrder: null,
    });
    const _: Task = result satisfies Task;
    expect(result.id).toBe('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
  });
});

// ---- Stable-output tests (same args → same result) -------------------------

describe('task-service.demo — stable output for reads', () => {
  it('getTaskById is deterministic for same id', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const a = await demo.getTaskById('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    const b = await demo.getTaskById('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(a.id).toBe(b.id);
    expect(a.title).toBe(b.title);
    expect(a.status).toBe(b.status);
  });

  it('listTasksByStatus({ status: "done" }) always returns same count', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const { tasks: a } = await demo.listTasksByStatus({ status: 'done' });
    const { tasks: b } = await demo.listTasksByStatus({ status: 'done' });
    expect(a.length).toBe(b.length);
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it('listReadyTasks() is deterministic', async () => {
    const demo = await import('@/lib/services/task-service.demo');
    const a = await demo.listReadyTasks();
    const b = await demo.listReadyTasks();
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });
});

// ---- DB is never touched when demo mode is on --------------------------------
// vi.mock is hoisted, so we set the factory at module level using vi.hoisted.

const { mockDb } = vi.hoisted(() => ({
  mockDb: new Proxy(
    {},
    {
      get() {
        throw new Error('DB accessed in demo mode — short-circuit failed');
      },
    },
  ),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

describe('task-service — short-circuit before DB in demo mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not access db when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');

    const svc = await import('@/lib/services/task-service');
    // Should not throw even though db proxy throws on any access
    await expect(svc.getTaskById('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa')).resolves.toBeDefined();

    vi.unstubAllEnvs();
  });
});
