import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLimit = vi.fn();
const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

vi.mock('@/lib/db', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  workerConfig: { key: 'key', value: 'value' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
}));

import { getWorkerConfigNumber } from '@/lib/services/worker-config-service';

describe('worker-config-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelect.mockReturnValue({ from: mockFrom });
    mockFrom.mockReturnValue({ where: mockWhere });
    mockWhere.mockReturnValue({ limit: mockLimit });
  });

  it('returns number from database', async () => {
    mockLimit.mockResolvedValue([{ value: 5 }]);
    const result = await getWorkerConfigNumber('max_spawn_depth');
    expect(result).toBe(5);
  });

  it('returns fallback when key not found', async () => {
    mockLimit.mockResolvedValue([]);
    const result = await getWorkerConfigNumber('unknown_key', 42);
    expect(result).toBe(42);
  });

  it('returns default when no fallback provided', async () => {
    mockLimit.mockResolvedValue([]);
    const result = await getWorkerConfigNumber('max_spawn_depth');
    expect(result).toBe(3); // DEFAULTS['max_spawn_depth'] = 3
  });

  it('handles non-numeric values gracefully', async () => {
    mockLimit.mockResolvedValue([{ value: 'not-a-number' }]);
    const result = await getWorkerConfigNumber('max_spawn_depth', 7);
    expect(result).toBe(7);
  });

  it('returns 0 when no fallback and key not in defaults', async () => {
    mockLimit.mockResolvedValue([]);
    const result = await getWorkerConfigNumber('completely_unknown');
    expect(result).toBe(0);
  });
});
