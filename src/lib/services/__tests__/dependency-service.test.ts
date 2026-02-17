import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDependency = {
  taskId: '00000000-0000-0000-0000-000000000001',
  dependsOnTaskId: '00000000-0000-0000-0000-000000000002',
  createdAt: new Date(),
};

// Use vi.hoisted so these are available in the vi.mock factory
const { mockState } = vi.hoisted(() => ({
  mockState: {
    selectResult: [] as unknown[],
    insertResult: [
      {
        taskId: '00000000-0000-0000-0000-000000000001',
        dependsOnTaskId: '00000000-0000-0000-0000-000000000002',
        createdAt: new Date(),
      },
    ] as unknown[],
    deleteResult: [
      {
        taskId: '00000000-0000-0000-0000-000000000001',
        dependsOnTaskId: '00000000-0000-0000-0000-000000000002',
        createdAt: new Date(),
      },
    ] as unknown[],
    txExecuteResult: { rows: [] as unknown[], rowCount: 2 },
  },
}));

vi.mock('@/lib/db', () => {
  const createTx = () => ({
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve(mockState.selectResult), {
          where: vi.fn().mockReturnValue(
            Object.assign(Promise.resolve(mockState.selectResult), {
              limit: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
            }),
          ),
        }),
      ),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => Promise.resolve(mockState.insertResult)),
      }),
    }),
    execute: vi.fn().mockImplementation(() => Promise.resolve(mockState.txExecuteResult)),
  });

  return {
    db: {
      transaction: vi
        .fn()
        .mockImplementation(async (cb: (tx: ReturnType<typeof createTx>) => Promise<unknown>) => {
          return cb(createTx());
        }),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue(
          Object.assign(Promise.resolve(mockState.selectResult), {
            where: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
            innerJoin: vi.fn().mockReturnValue(
              Object.assign(Promise.resolve(mockState.selectResult), {
                where: vi.fn().mockImplementation(() => Promise.resolve(mockState.selectResult)),
              }),
            ),
          }),
        ),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockImplementation(() => Promise.resolve(mockState.deleteResult)),
        }),
      }),
    },
  };
});

import { addDependency, removeDependency, listDependencies } from '../dependency-service';
import { db } from '@/lib/db';

describe('dependency-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.selectResult = [];
    mockState.insertResult = [mockDependency];
    mockState.deleteResult = [mockDependency];
    mockState.txExecuteResult = { rows: [], rowCount: 2 };
  });

  describe('addDependency', () => {
    it('rejects self-dependency (A -> A)', async () => {
      const taskId = '00000000-0000-0000-0000-000000000001';

      await expect(addDependency(taskId, taskId)).rejects.toThrow('A task cannot depend on itself');
    });

    it('validates self-dependency check before hitting the database', async () => {
      const taskId = '00000000-0000-0000-0000-000000000001';

      await expect(addDependency(taskId, taskId)).rejects.toThrow();

      // Self-dependency check is early validation - transaction should not be called
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns existing dependency on idempotent add', async () => {
      const existingDep = {
        taskId: '00000000-0000-0000-0000-000000000001',
        dependsOnTaskId: '00000000-0000-0000-0000-000000000002',
        createdAt: new Date(),
      };
      // The select inside the transaction finds an existing dependency
      mockState.selectResult = [existingDep];
      mockState.txExecuteResult = { rows: [], rowCount: 2 };

      const result = await addDependency(
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002',
      );

      expect(result).toEqual(existingDep);
    });
  });

  describe('removeDependency', () => {
    it('throws NotFoundError when removing nonexistent dependency', async () => {
      mockState.deleteResult = []; // No rows deleted

      await expect(
        removeDependency(
          '00000000-0000-0000-0000-000000000001',
          '00000000-0000-0000-0000-000000000099',
        ),
      ).rejects.toThrow('Dependency not found');
    });
  });

  describe('listDependencies', () => {
    it('returns correct shape with id, title, status', async () => {
      const depTasks = [
        { id: 'dep-1', title: 'Dependency 1', status: 'todo' },
        { id: 'dep-2', title: 'Dependency 2', status: 'in_progress' },
      ];
      mockState.selectResult = depTasks;

      const result = await listDependencies('00000000-0000-0000-0000-000000000001');

      expect(result).toEqual(depTasks);
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('title');
      expect(result[0]).toHaveProperty('status');
    });
  });
});
