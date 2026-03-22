import { describe, expect, it } from 'vitest';
import { createScopedDedup } from '../scoped-dedup';

describe('createScopedDedup', () => {
  it('returns false for keys not yet added', () => {
    const dedup = createScopedDedup<number>();
    expect(dedup.has('scope-1', 42)).toBe(false);
  });

  it('returns true for keys that have been added', () => {
    const dedup = createScopedDedup<number>();
    dedup.add('scope-1', 42);
    expect(dedup.has('scope-1', 42)).toBe(true);
  });

  it('isolates scopes from each other', () => {
    const dedup = createScopedDedup<number>();
    dedup.add('scope-1', 42);

    expect(dedup.has('scope-1', 42)).toBe(true);
    expect(dedup.has('scope-2', 42)).toBe(false);
  });

  it('add returns true for new keys, false for duplicates', () => {
    const dedup = createScopedDedup<number>();

    expect(dedup.add('s', 1)).toBe(true);
    expect(dedup.add('s', 2)).toBe(true);
    expect(dedup.add('s', 1)).toBe(false); // duplicate
  });

  it('clear removes all keys for a scope', () => {
    const dedup = createScopedDedup<number>();
    dedup.add('s1', 1);
    dedup.add('s1', 2);
    dedup.add('s2', 1);

    dedup.clear('s1');

    expect(dedup.has('s1', 1)).toBe(false);
    expect(dedup.has('s1', 2)).toBe(false);
    expect(dedup.has('s2', 1)).toBe(true); // other scope unaffected
  });

  it('size returns the number of tracked keys', () => {
    const dedup = createScopedDedup<number>();

    expect(dedup.size('s1')).toBe(0);

    dedup.add('s1', 1);
    dedup.add('s1', 2);
    dedup.add('s1', 2); // duplicate — should not increase size

    expect(dedup.size('s1')).toBe(2);
  });

  it('size returns 0 for unknown scopes', () => {
    const dedup = createScopedDedup<number>();
    expect(dedup.size('nonexistent')).toBe(0);
  });

  it('clear on unknown scope is a no-op', () => {
    const dedup = createScopedDedup<number>();
    // Should not throw
    dedup.clear('nonexistent');
  });

  it('works with string keys', () => {
    const dedup = createScopedDedup<string>();
    dedup.add('room-1', 'msg-key-abc');

    expect(dedup.has('room-1', 'msg-key-abc')).toBe(true);
    expect(dedup.has('room-1', 'msg-key-def')).toBe(false);
  });

  it('can add to a scope after clearing it', () => {
    const dedup = createScopedDedup<number>();
    dedup.add('s1', 1);
    dedup.clear('s1');
    dedup.add('s1', 2);

    expect(dedup.has('s1', 1)).toBe(false);
    expect(dedup.has('s1', 2)).toBe(true);
    expect(dedup.size('s1')).toBe(1);
  });
});
