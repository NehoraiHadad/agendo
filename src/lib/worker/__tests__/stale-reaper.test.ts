import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db before importing StaleReaper
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();
const mockReturning = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: mockFrom }),
    update: () => ({ set: mockSet }),
  },
}));

vi.mock('@/lib/config', () => ({
  config: {
    STALE_JOB_THRESHOLD_MS: 120000,
  },
}));

// Must import after mocks
const { StaleReaper } = await import('../stale-reaper');

describe('StaleReaper', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Chain: db.select({ id }).from(table).where(...)
    mockFrom.mockReturnValue({ where: mockWhere });
    // Chain: db.update(table).set({ ... }).where(...).returning(...)
    mockSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockReturnValue({ returning: mockReturning });
    mockReturning.mockResolvedValue([]);
  });

  it('returns 0 when no stale rows found', async () => {
    mockWhere.mockResolvedValue([]); // both executions and sessions return empty

    const reaper = new StaleReaper();
    const count = await reaper.reap();

    expect(count).toBe(0);
  });

  it('marks stale executions as timed_out', async () => {
    // First call: stale executions; second call: stale sessions (empty)
    mockWhere.mockResolvedValueOnce([{ id: 'exec-1' }, { id: 'exec-2' }]).mockResolvedValueOnce([]);
    // Execution updates don't use returning(), just resolve the where
    mockUpdateWhere.mockResolvedValue({ rowCount: 1 });

    const reaper = new StaleReaper();
    const count = await reaper.reap();

    expect(count).toBe(2);
    expect(mockSet).toHaveBeenCalledWith({
      status: 'timed_out',
      error: 'Heartbeat lost — worker stale',
    });
  });

  it('only kills PIDs for sessions that were actually reaped', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    // First call: stale executions (empty); second call: stale sessions
    mockWhere.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'session-1', pid: 1234 },
      { id: 'session-2', pid: 5678 },
    ]);

    // Session-1 was re-claimed (UPDATE returns empty), session-2 was truly stale
    mockReturning
      .mockResolvedValueOnce([]) // session-1: no-op
      .mockResolvedValueOnce([{ id: 'session-2' }]); // session-2: reaped

    const reaper = new StaleReaper();
    await reaper.reap();

    // Should only kill PID 5678 (session-2), NOT 1234 (session-1 was re-claimed)
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(-5678, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('start() and stop() manage the timer', () => {
    vi.useFakeTimers();
    const reaper = new StaleReaper();

    reaper.start();
    // Timer should be set
    expect(reaper['timer']).not.toBeNull();

    reaper.stop();
    expect(reaper['timer']).toBeNull();

    vi.useRealTimers();
  });
});
