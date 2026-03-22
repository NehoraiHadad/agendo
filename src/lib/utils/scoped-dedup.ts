/**
 * Scoped deduplication index using O(1) Set lookups.
 *
 * Maintains per-scope Sets so multiple independent streams (e.g. different
 * session IDs) each have their own dedup index without interfering.
 *
 * Module-level by design — NOT stored in React/Zustand state to avoid
 * triggering re-renders on dedup bookkeeping.
 *
 * @example
 * ```ts
 * const dedup = createScopedDedup<number>();
 *
 * dedup.has('session-1', 42);   // false
 * dedup.add('session-1', 42);
 * dedup.has('session-1', 42);   // true
 * dedup.has('session-2', 42);   // false (different scope)
 *
 * dedup.clear('session-1');     // reset on reconnect/unmount
 * ```
 */
export interface ScopedDedup<K> {
  /** Check if a key exists in the given scope. */
  has: (scope: string, key: K) => boolean;
  /** Add a key to the given scope. Returns true if newly added, false if already present. */
  add: (scope: string, key: K) => boolean;
  /** Clear all keys for a scope (e.g. on reconnect or unmount). */
  clear: (scope: string) => void;
  /** Get the number of tracked keys in a scope. */
  size: (scope: string) => number;
}

export function createScopedDedup<K = number>(): ScopedDedup<K> {
  const sets = new Map<string, Set<K>>();

  function getSet(scope: string): Set<K> {
    let set = sets.get(scope);
    if (!set) {
      set = new Set<K>();
      sets.set(scope, set);
    }
    return set;
  }

  return {
    has(scope: string, key: K): boolean {
      return sets.get(scope)?.has(key) ?? false;
    },

    add(scope: string, key: K): boolean {
      const set = getSet(scope);
      if (set.has(key)) return false;
      set.add(key);
      return true;
    },

    clear(scope: string): void {
      sets.delete(scope);
    },

    size(scope: string): number {
      return sets.get(scope)?.size ?? 0;
    },
  };
}
