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

// Mock pg-notify to prevent real PG NOTIFY calls
vi.mock('@/lib/realtime/pg-notify', () => ({
  broadcastSessionStatus: vi.fn().mockResolvedValue(undefined),
  channelName: vi.fn((_prefix: string, id: string) => `test_${id}`),
  publish: vi.fn().mockResolvedValue(undefined),
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

  it('returns 0 when no stale sessions found', async () => {
    mockWhere.mockResolvedValue([]);

    const reaper = new StaleReaper();
    const count = await reaper.reap();

    expect(count).toBe(0);
  });

  it('only kills PIDs for sessions that were actually reaped', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    mockWhere.mockResolvedValueOnce([
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

  it('does NOT kill when pid=0 (SDK adapter — no real OS process)', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    mockWhere.mockResolvedValueOnce([{ id: 'sdk-session', pid: 0 }]);
    // Session was truly stale (UPDATE returned a row)
    mockReturning.mockResolvedValueOnce([{ id: 'sdk-session' }]);

    const reaper = new StaleReaper();
    await reaper.reap();

    // pid=0 must never reach process.kill — would SIGTERM the whole process group
    expect(killSpy).not.toHaveBeenCalled();

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
