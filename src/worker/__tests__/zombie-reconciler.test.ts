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
  sessions: {
    id: 'id',
    pid: 'pid',
    status: 'status',
    workerId: 'worker_id',
    sessionRef: 'session_ref',
    lastActiveAt: 'last_active_at',
    initialPrompt: 'initial_prompt',
  },
}));

// Mock queue to prevent config/DATABASE_URL loading in tests
vi.mock('../../lib/worker/queue', () => ({
  enqueueSession: vi.fn().mockResolvedValue(null),
}));

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ type: 'eq', val })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  inArray: vi.fn((_col, vals) => ({ type: 'inArray', vals })),
}));

import { db } from '../../lib/db/index';
import { reconcileZombies } from '../zombie-reconciler';
import { enqueueSession } from '../../lib/worker/queue';

const mockDb = vi.mocked(db);
const mockEnqueue = vi.mocked(enqueueSession);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// Helper to set up session query result
function mockSessionsResult(
  rows: Array<{ id: string; pid: number | null; status: string; sessionRef?: string | null }>,
) {
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
  it('returns early when no orphaned sessions found', async () => {
    mockSessionsResult([]);

    await reconcileZombies('worker-1');

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('marks awaiting_input session as idle without killing', async () => {
    mockSessionsResult([{ id: 'sess-1', pid: 12345, status: 'awaiting_input', sessionRef: null }]);
    const { mockSetFn } = mockUpdateChain();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await reconcileZombies('worker-1');

    // should NOT kill the PID for awaiting_input
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSetFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'idle', workerId: null }),
    );

    killSpy.mockRestore();
  });

  it('kills alive PID for active session (process group)', async () => {
    mockSessionsResult([{ id: 'sess-2', pid: 12345, status: 'active', sessionRef: null }]);
    mockUpdateChain();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await reconcileZombies('worker-1');

    // Should check liveness with signal 0 then kill the process group
    expect(killSpy).toHaveBeenCalledWith(12345, 0);
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('marks active session as idle after killing', async () => {
    mockSessionsResult([{ id: 'sess-3', pid: null, status: 'active', sessionRef: null }]);
    const { mockSetFn } = mockUpdateChain();

    await reconcileZombies('worker-1');

    expect(mockSetFn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'idle', workerId: null }),
    );
  });

  it('re-enqueues active session that has sessionRef', async () => {
    mockSessionsResult([{ id: 'sess-4', pid: null, status: 'active', sessionRef: 'some-ref' }]);
    // Need 2 update calls: set idle + set initialPrompt
    const mockWhere = vi.fn().mockResolvedValue(undefined);
    const mockSetFn = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.update.mockReturnValue({ set: mockSetFn } as never);

    await reconcileZombies('worker-1');

    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-4', resumeRef: 'some-ref' }),
    );
  });

  it('handles multiple orphaned sessions', async () => {
    mockSessionsResult([
      { id: 'sess-a', pid: null, status: 'active', sessionRef: null },
      { id: 'sess-b', pid: null, status: 'active', sessionRef: null },
    ]);
    mockUpdateChain();

    await reconcileZombies('worker-1');

    expect(mockDb.update).toHaveBeenCalledTimes(2);
  });

  it('catches gracefully when SIGTERM throws', async () => {
    mockSessionsResult([{ id: 'sess-5', pid: 55555, status: 'active', sessionRef: null }]);
    mockUpdateChain();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true; // alive check succeeds
      throw new Error('EPERM'); // SIGTERM fails
    });

    // Should not throw
    await expect(reconcileZombies('worker-1')).resolves.toBeUndefined();

    killSpy.mockRestore();
  });

  it('queries only sessions for the given workerId', async () => {
    mockSessionsResult([]);

    await reconcileZombies('worker-1');

    expect(mockDb.select).toHaveBeenCalled();
  });
});
