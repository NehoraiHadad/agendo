import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock task data ---
const mockTaskBase = {
  id: '00000000-0000-0000-0000-000000000001',
  ownerId: '00000000-0000-0000-0000-000000000001',
  workspaceId: '00000000-0000-0000-0000-000000000001',
  parentTaskId: null,
  projectId: null,
  title: 'Test Task',
  description: null,
  status: 'todo' as const,
  priority: 3,
  sortOrder: 1000,
  assigneeAgentId: null,
  isAdHoc: false,
  inputContext: {},
  dueAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Use vi.hoisted so these are available in the vi.mock factory (which is hoisted)
const { mockState } = vi.hoisted(() => {
  return {
    mockState: {
      selectResult: [] as unknown[],
      insertResult: [] as unknown[],
    },
  };
});

vi.mock('@/lib/db', () => {
  // Chainable select: db.select().from(t).where(...).orderBy(...).limit(n)
  const createFromResult = () => {
    const whereResult = () =>
      Object.assign(Promise.resolve(mockState.selectResult), {
        limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
        orderBy: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
        })),
      });

    return Object.assign(Promise.resolve(mockState.selectResult), {
      where: vi.fn().mockImplementation(whereResult),
      orderBy: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(mockState.selectResult), {
          limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
        }),
      ),
      limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
    });
  };

  const mockFrom = vi.fn().mockImplementation(createFromResult);

  // Chainable insert: db.insert(t).values({}).returning()
  const mockReturning = vi.fn().mockImplementation(() => Promise.resolve(mockState.insertResult));
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });

  // Chainable update: db.update(t).set({}).where({}).returning()
  const mockUpdateReturning = vi
    .fn()
    .mockImplementation(() => Promise.resolve(mockState.insertResult));
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
  const mockSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });

  return {
    db: {
      select: vi.fn().mockReturnValue({ from: mockFrom }),
      insert: vi.fn().mockReturnValue({ values: mockValues }),
      update: vi.fn().mockReturnValue({ set: mockSet }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000001' }]),
        }),
      }),
      execute: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
    },
  };
});

import { createTask, updateTask, listTasksByStatus, listTasksBoardItems } from '../task-service';
import { computeSortOrder } from '@/lib/sort-order';

describe('task-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.selectResult = [];
    mockState.insertResult = [mockTaskBase];
  });

  describe('computeSortOrder (extracted to sort-order.ts)', () => {
    it('returns correct midpoint between 1000 and 2000', () => {
      const result = computeSortOrder(1000, 2000);
      expect(result.value).toBe(1500);
      expect(result.needsReindex).toBe(false);
    });

    it('signals needsReindex on tiny gap (1000, 1001)', () => {
      const result = computeSortOrder(1000, 1001);
      expect(result.needsReindex).toBe(true);
    });
  });

  describe('createTask', () => {
    it('sets sparse sort_order with SORT_ORDER_GAP (1000) increments', async () => {
      // No existing tasks, so getNextSortOrder returns SORT_ORDER_GAP (1000)
      mockState.selectResult = [];
      mockState.insertResult = [{ ...mockTaskBase, sortOrder: 1000 }];

      const result = await createTask({ title: 'New Task' });
      expect(result.sortOrder).toBe(1000);
    });

    it('creates an ad-hoc task when isAdHoc: true is provided', async () => {
      mockState.selectResult = [];
      mockState.insertResult = [{ ...mockTaskBase, isAdHoc: true }];

      const result = await createTask({ title: 'Ad-hoc · Feb 23, 10:00', isAdHoc: true });
      expect(result.isAdHoc).toBe(true);
    });

    it('defaults isAdHoc to false for regular tasks', async () => {
      mockState.selectResult = [];
      mockState.insertResult = [{ ...mockTaskBase, isAdHoc: false }];

      const result = await createTask({ title: 'Regular Task' });
      expect(result.isAdHoc).toBe(false);
    });
  });

  describe('updateTask', () => {
    it('rejects invalid transition: done -> in_progress', async () => {
      const doneTask = { ...mockTaskBase, status: 'done' as const };
      mockState.selectResult = [doneTask];

      await expect(updateTask(doneTask.id, { status: 'in_progress' })).rejects.toThrow(
        'Invalid status transition',
      );
    });

    it('allows valid transition: todo -> in_progress', async () => {
      const todoTask = { ...mockTaskBase, status: 'todo' as const };
      mockState.selectResult = [todoTask];
      mockState.insertResult = [{ ...todoTask, status: 'in_progress' }];

      const result = await updateTask(todoTask.id, { status: 'in_progress' });
      expect(result.status).toBe('in_progress');
    });

    it('allows reopen: done -> todo', async () => {
      const doneTask = { ...mockTaskBase, status: 'done' as const };
      mockState.selectResult = [doneTask];
      mockState.insertResult = [{ ...doneTask, status: 'todo' }];

      const result = await updateTask(doneTask.id, { status: 'todo' });
      expect(result.status).toBe('todo');
    });
  });

  describe('listTasksByStatus', () => {
    it('respects cursor - returns only tasks after cursor value', async () => {
      const task2 = {
        ...mockTaskBase,
        id: 'task-2',
        sortOrder: 2000,
        sort_order: 2000,
        is_ad_hoc: false,
        owner_id: mockTaskBase.ownerId,
        workspace_id: mockTaskBase.workspaceId,
        parent_task_id: null,
        project_id: null,
        assignee_agent_id: null,
        input_context: {},
        due_at: null,
        created_at: mockTaskBase.createdAt,
        updated_at: mockTaskBase.updatedAt,
        subtask_total: 0,
        subtask_done: 0,
      };
      mockState.selectResult = [task2];

      const result = await listTasksByStatus({ status: 'todo', cursor: '1000', limit: 50 });

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe('task-2');
    });

    it('detects hasMore - returns nextCursor when more than limit exist', async () => {
      // Create limit + 1 tasks to trigger hasMore detection
      // listTasksBoardItems uses db.execute() which returns raw snake_case column names
      const tasksArray = Array.from({ length: 3 }, (_, i) => ({
        ...mockTaskBase,
        id: `task-${i}`,
        sortOrder: (i + 1) * 1000,
        sort_order: (i + 1) * 1000, // snake_case for the raw SQL mapper in listTasksBoardItems
        is_ad_hoc: false,
        owner_id: mockTaskBase.ownerId,
        workspace_id: mockTaskBase.workspaceId,
        parent_task_id: null,
        project_id: null,
        assignee_agent_id: null,
        input_context: {},
        due_at: null,
        created_at: mockTaskBase.createdAt,
        updated_at: mockTaskBase.updatedAt,
        subtask_total: 0,
        subtask_done: 0,
      }));
      mockState.selectResult = tasksArray;

      const result = await listTasksByStatus({ status: 'todo', limit: 2 });

      // limit=2, DB returned 3 (limit+1), so hasMore=true
      expect(result.tasks).toHaveLength(2);
      expect(result.nextCursor).toBe('2000');
    });
  });

  describe('listTasksBoardItems mapper', () => {
    it('maps is_ad_hoc snake_case column to isAdHoc camelCase', async () => {
      const rawRow = {
        id: '00000000-0000-0000-0000-000000000099',
        owner_id: '00000000-0000-0000-0000-000000000001',
        workspace_id: '00000000-0000-0000-0000-000000000001',
        parent_task_id: null,
        project_id: null,
        title: 'Ad-hoc Task',
        description: null,
        status: 'in_progress',
        priority: 3,
        sort_order: 1000,
        assignee_agent_id: null,
        is_ad_hoc: true,
        input_context: {},
        due_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        subtask_total: 0,
        subtask_done: 0,
      };
      mockState.selectResult = [rawRow];

      const result = await listTasksBoardItems([]);

      expect(result).toHaveLength(1);
      expect(result[0].isAdHoc).toBe(true);
    });

    it('maps is_ad_hoc = false correctly', async () => {
      const rawRow = {
        id: '00000000-0000-0000-0000-000000000099',
        owner_id: '00000000-0000-0000-0000-000000000001',
        workspace_id: '00000000-0000-0000-0000-000000000001',
        parent_task_id: null,
        project_id: null,
        title: 'Regular Task',
        description: null,
        status: 'todo',
        priority: 3,
        sort_order: 1000,
        assignee_agent_id: null,
        is_ad_hoc: false,
        input_context: {},
        due_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        subtask_total: 0,
        subtask_done: 0,
      };
      mockState.selectResult = [rawRow];

      const result = await listTasksBoardItems([]);

      expect(result).toHaveLength(1);
      expect(result[0].isAdHoc).toBe(false);
    });
  });
});
