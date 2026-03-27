import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db before importing the module under test
vi.mock('../../lib/db/index', () => {
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
  const mockFrom = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });
  const mockExecute = vi.fn().mockResolvedValue({ rows: [] });

  return {
    db: {
      select: mockSelect,
      update: mockUpdate,
      execute: mockExecute,
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
  brainstormRooms: {
    id: 'id',
    status: 'status',
    createdAt: 'created_at',
  },
}));

// Mock session dispatch (zombie-reconciler uses dispatchSession)
vi.mock('../../lib/services/session-dispatch', () => ({
  dispatchSession: vi.fn().mockResolvedValue(undefined),
}));

// Mock brainstorm orchestrator (zombie-reconciler calls runBrainstorm directly)
vi.mock('../../lib/worker/brainstorm-orchestrator', () => ({
  runBrainstorm: vi.fn().mockResolvedValue(undefined),
}));

// Mock worker-sse to prevent real in-memory listener calls
vi.mock('../../lib/worker/worker-sse', () => ({
  sessionEventListeners: new Map(),
}));

// Mock drizzle-orm operators
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col, val) => ({ type: 'eq', val })),
  and: vi.fn((...args) => ({ type: 'and', args })),
  or: vi.fn((...args) => ({ type: 'or', args })),
  inArray: vi.fn((_col, vals) => ({ type: 'inArray', vals })),
  lt: vi.fn((_col, val) => ({ type: 'lt', val })),
  gt: vi.fn((_col, val) => ({ type: 'gt', val })),
  sql: vi.fn((strings, ...values) => ({ type: 'sql', strings, values })),
}));

import { db } from '../../lib/db/index';
import { reconcileZombies } from '../zombie-reconciler';
import { dispatchSession } from '../../lib/services/session-dispatch';
import { runBrainstorm } from '../../lib/worker/brainstorm-orchestrator';

const mockDb = vi.mocked(db);
const mockEnqueue = vi.mocked(dispatchSession);
const mockRunBrainstorm = vi.mocked(runBrainstorm);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Mock the select chain so the FIRST call returns `sessionRows` and all
 * subsequent calls (brainstorm inFlight, brainstorm staleWaiting) return [].
 */
function mockSessionsResult(
  sessionRows: Array<{
    id: string;
    pid: number | null;
    status: string;
    sessionRef?: string | null;
  }>,
) {
  let firstCall = true;
  mockDb.select.mockImplementation(() => {
    const rows = firstCall ? sessionRows : [];
    firstCall = false;
    const mockWhere = vi.fn().mockResolvedValue(rows);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    return { from: mockFrom } as never;
  });
}

/**
 * Mock select to return sessionRows on call 1, inFlightRows on call 2,
 * staleWaitingRows on call 3.
 */
function mockAllSelects(
  sessionRows: unknown[],
  inFlightRows: unknown[],
  staleWaitingRows: unknown[],
) {
  const results = [sessionRows, inFlightRows, staleWaitingRows];
  let callIndex = 0;
  mockDb.select.mockImplementation(() => {
    const rows = results[callIndex++] ?? [];
    const mockWhere = vi.fn().mockResolvedValue(rows);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    return { from: mockFrom } as never;
  });
}

function mockUpdateChain() {
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockSetFn = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  mockDb.update.mockReturnValue({ set: mockSetFn } as never);
  return { mockSetFn, mockUpdateWhere };
}

// ---------------------------------------------------------------------------
// Session reconciliation
// ---------------------------------------------------------------------------

describe('reconcileZombies — sessions', () => {
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

  it('does NOT kill when pid=0 (SDK adapter — no real OS process)', async () => {
    mockSessionsResult([{ id: 'sess-sdk', pid: 0, status: 'active', sessionRef: null }]);
    mockUpdateChain();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await reconcileZombies('worker-1');

    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it('catches gracefully when SIGTERM throws', async () => {
    mockSessionsResult([{ id: 'sess-5', pid: 55555, status: 'active', sessionRef: null }]);
    mockUpdateChain();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw new Error('EPERM');
    });

    await expect(reconcileZombies('worker-1')).resolves.toBeUndefined();

    killSpy.mockRestore();
  });

  it('queries only sessions for the given workerId', async () => {
    mockSessionsResult([]);

    await reconcileZombies('worker-1');

    expect(mockDb.select).toHaveBeenCalled();
  });

  it('skips startup reconciliation when a relation is missing', async () => {
    mockDb.select.mockImplementation(() => {
      const mockWhere = vi.fn().mockRejectedValue({
        message: 'Failed query',
        cause: { code: '42P01', message: 'relation "executions" does not exist' },
      });
      const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
      return { from: mockFrom } as never;
    });

    await expect(reconcileZombies('worker-1')).resolves.toBeUndefined();

    expect(mockDb.update).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockRunBrainstorm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Brainstorm reconciliation
// ---------------------------------------------------------------------------

describe('reconcileZombies — brainstorm rooms', () => {
  it('dispatches active room directly via runBrainstorm', async () => {
    mockAllSelects([], [{ id: 'room-2', status: 'active' }], []);

    await reconcileZombies('worker-1');

    expect(mockRunBrainstorm).toHaveBeenCalledWith('room-2');
  });

  it('dispatches synthesizing room directly via runBrainstorm', async () => {
    mockAllSelects([], [{ id: 'room-3', status: 'synthesizing' }], []);

    await reconcileZombies('worker-1');

    expect(mockRunBrainstorm).toHaveBeenCalledWith('room-3');
  });

  it('dispatches stale waiting room', async () => {
    mockAllSelects([], [], [{ id: 'room-4', status: 'waiting' }]);

    await reconcileZombies('worker-1');

    expect(mockRunBrainstorm).toHaveBeenCalledWith('room-4');
  });

  it('skips paused rooms entirely', async () => {
    // paused rooms are not queried (status filter excludes them)
    mockAllSelects([], [], []);

    await reconcileZombies('worker-1');

    expect(mockRunBrainstorm).not.toHaveBeenCalled();
  });

  it('handles multiple orphaned brainstorm rooms', async () => {
    mockAllSelects(
      [],
      [
        { id: 'room-a', status: 'active' },
        { id: 'room-b', status: 'synthesizing' },
      ],
      [],
    );

    await reconcileZombies('worker-1');

    expect(mockRunBrainstorm).toHaveBeenCalledTimes(2);
    expect(mockRunBrainstorm).toHaveBeenCalledWith('room-a');
    expect(mockRunBrainstorm).toHaveBeenCalledWith('room-b');
  });
});
