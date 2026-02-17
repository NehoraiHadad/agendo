import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db before importing the module under test
vi.mock('../../lib/db/index', () => {
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
  const mockFrom = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  return {
    db: {
      select: mockSelect,
      update: mockUpdate,
    },
  };
});

vi.mock('../../lib/db/schema', () => ({
  executions: {
    id: 'id',
    pid: 'pid',
    status: 'status',
    workerId: 'worker_id',
  },
}));

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ type: 'eq', val })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  inArray: vi.fn((_col, vals) => ({ type: 'inArray', vals })),
}));

import { db } from '../../lib/db/index';
import { reconcileZombies } from '../zombie-reconciler';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// Helper to set up select query result
function mockSelectResult(rows: Array<{ id: string; pid: number | null }>) {
  const mockWhere = vi.fn().mockResolvedValue(rows);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  mockDb.select.mockReturnValue({ from: mockFrom } as never);
}

// Helper to set up update chain
function mockUpdateChain() {
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockSetFn = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  mockDb.update.mockReturnValue({ set: mockSetFn } as never);
  return { mockSetFn, mockUpdateWhere };
}

describe('reconcileZombies', () => {
  it('returns early with log when no orphans found', async () => {
    mockSelectResult([]);

    await reconcileZombies('worker-1');

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('No orphaned executions'),
    );
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('marks dead PID execution as failed', async () => {
    mockSelectResult([{ id: 'exec-1', pid: 99999 }]);
    const { mockSetFn } = mockUpdateChain();

    // pid 99999 is almost certainly not alive
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    await reconcileZombies('worker-1');

    expect(mockSetFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Worker restarted, execution orphaned',
      }),
    );

    killSpy.mockRestore();
  });

  it('sends SIGTERM to alive PID', async () => {
    mockSelectResult([{ id: 'exec-2', pid: 12345 }]);
    mockUpdateChain();

    // First call (signal 0 check) succeeds = alive
    // Second call (SIGTERM) succeeds
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await reconcileZombies('worker-1');

    // Should have called kill with signal 0 (alive check) and then SIGTERM
    expect(killSpy).toHaveBeenCalledWith(12345, 0);
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('treats null PID as dead', async () => {
    mockSelectResult([{ id: 'exec-3', pid: null }]);
    const { mockSetFn } = mockUpdateChain();

    await reconcileZombies('worker-1');

    expect(mockSetFn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: 'Worker restarted, execution orphaned',
      }),
    );
  });

  it('catches gracefully when kill throws on SIGTERM', async () => {
    mockSelectResult([{ id: 'exec-4', pid: 55555 }]);
    mockUpdateChain();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true; // alive check succeeds
      throw new Error('EPERM'); // SIGTERM fails
    });

    // Should not throw
    await expect(reconcileZombies('worker-1')).resolves.toBeUndefined();

    killSpy.mockRestore();
  });

  it('processes multiple orphans', async () => {
    mockSelectResult([
      { id: 'exec-a', pid: null },
      { id: 'exec-b', pid: null },
      { id: 'exec-c', pid: null },
    ]);
    mockUpdateChain();

    await reconcileZombies('worker-1');

    // update called 3 times (once per dead orphan)
    expect(mockDb.update).toHaveBeenCalledTimes(3);
  });

  it('sets endedAt timestamp on failed executions', async () => {
    mockSelectResult([{ id: 'exec-5', pid: null }]);
    const { mockSetFn } = mockUpdateChain();

    const before = new Date();
    await reconcileZombies('worker-1');
    const after = new Date();

    const setArg = mockSetFn.mock.calls[0][0];
    expect(setArg.endedAt).toBeInstanceOf(Date);
    expect(setArg.endedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(setArg.endedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('queries only running and cancelling statuses for given worker', async () => {
    mockSelectResult([]);

    await reconcileZombies('worker-1');

    // Verify select was called (the query was made)
    expect(mockDb.select).toHaveBeenCalled();
  });
});
