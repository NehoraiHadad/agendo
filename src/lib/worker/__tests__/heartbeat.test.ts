import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockUpdate } = vi.hoisted(() => {
  const mockWhere = vi.fn().mockResolvedValue([]);
  const mockSet = vi.fn().mockReturnValue({ where: mockWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSet });
  return { mockUpdate };
});

vi.mock('@/lib/db', () => ({
  db: { update: mockUpdate },
}));

vi.mock('@/lib/db/schema', () => ({
  executions: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

import { ExecutionHeartbeat } from '@/lib/worker/heartbeat';

describe('ExecutionHeartbeat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  it('updates db on start', () => {
    const hb = new ExecutionHeartbeat('exec-1');
    hb.start();
    expect(mockUpdate).toHaveBeenCalled();
    hb.stop();
  });

  it('stops timer on stop', () => {
    const hb = new ExecutionHeartbeat('exec-1');
    hb.start();
    expect(vi.getTimerCount()).toBe(1);
    hb.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
