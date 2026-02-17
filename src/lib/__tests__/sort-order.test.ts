import { describe, it, expect } from 'vitest';
import { computeSortOrder, SORT_ORDER_GAP } from '../sort-order';

describe('computeSortOrder', () => {
  it('returns correct midpoint between 1000 and 2000', () => {
    const result = computeSortOrder(1000, 2000);
    expect(result.value).toBe(1500);
    expect(result.needsReindex).toBe(false);
  });

  it('signals needsReindex when gap is too small (1000, 1001)', () => {
    const result = computeSortOrder(1000, 1001);
    expect(result.value).toBe(1000);
    expect(result.needsReindex).toBe(true);
  });

  it('handles null after (inserting at top): halves before value', () => {
    const result = computeSortOrder(null, 2000);
    expect(result.value).toBe(1000);
    expect(result.needsReindex).toBe(false);
  });

  it('handles null before (inserting at bottom): after + GAP', () => {
    const result = computeSortOrder(1000, null);
    expect(result.value).toBe(1000 + SORT_ORDER_GAP);
    expect(result.needsReindex).toBe(false);
  });

  it('handles both null values (first item in column): returns GAP', () => {
    const result = computeSortOrder(null, null);
    expect(result.value).toBe(SORT_ORDER_GAP);
    expect(result.needsReindex).toBe(false);
  });

  it('detects needsReindex for very small before value at top', () => {
    const result = computeSortOrder(null, 1);
    expect(result.value).toBe(0);
    expect(result.needsReindex).toBe(true);
  });
});
