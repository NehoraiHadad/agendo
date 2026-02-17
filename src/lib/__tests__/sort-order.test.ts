import { describe, it, expect, vi } from 'vitest';

// Mock @/lib/db to prevent config.ts from calling process.exit
vi.mock('@/lib/db', () => ({
  db: {},
}));

import { calculateMidpoint } from '../services/task-service';

describe('calculateMidpoint', () => {
  it('returns correct midpoint between 1000 and 2000', () => {
    expect(calculateMidpoint(1000, 2000)).toBe(1500);
  });

  it('returns null when gap is too small (1000, 1001)', () => {
    expect(calculateMidpoint(1000, 1001)).toBeNull();
  });

  it('handles null before value', () => {
    // before=null means low=0, so midpoint of 0 and 2000 = 1000
    const result = calculateMidpoint(null, 2000);
    expect(result).toBe(1000);
  });

  it('handles null after value', () => {
    // after=null means high = low + SORT_ORDER_GAP * 2 = 1000 + 2000 = 3000
    // midpoint of 1000 and 3000 = 2000
    const result = calculateMidpoint(1000, null);
    expect(result).toBe(2000);
  });

  it('handles both null values', () => {
    // before=null => low=0, after=null => high = 0 + 2000 = 2000
    // midpoint of 0 and 2000 = 1000
    const result = calculateMidpoint(null, null);
    expect(result).toBe(1000);
  });
});
