import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db before importing StaleReaper
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockUpdateWhere = vi.fn();

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

    // Chain: db.select({ id }).from(executions).where(...)
    mockFrom.mockReturnValue({ where: mockWhere });
    // Chain: db.update(executions).set({ ... }).where(...)
    mockSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdateWhere.mockResolvedValue({ rowCount: 1 });
  });

  it('returns 0 when no stale rows found', async () => {
    mockWhere.mockResolvedValue([]); // both executions and sessions return empty

    const reaper = new StaleReaper();
    const count = await reaper.reap();

    expect(count).toBe(0);
  });

  it('marks stale rows as timed_out', async () => {
    // First call: stale executions; second call: stale sessions (empty)
    mockWhere
      .mockResolvedValueOnce([{ id: 'exec-1' }, { id: 'exec-2' }])
      .mockResolvedValueOnce([]);

    const reaper = new StaleReaper();
    const count = await reaper.reap();

    expect(count).toBe(2);
    expect(mockSet).toHaveBeenCalledTimes(2);
    expect(mockSet).toHaveBeenCalledWith({
      status: 'timed_out',
      error: 'Heartbeat lost — worker stale',
    });
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
