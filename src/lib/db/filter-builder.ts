import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

type FilterValue = string | number | boolean | undefined | null;

/**
 * Build a Drizzle `and(...)` clause from a key-value filter object and a
 * column map.  Entries whose value is `undefined` or `null` are silently
 * skipped, so callers can pass optional filter fields directly without
 * pre-filtering.
 *
 * Returns `undefined` when no conditions apply (safe to pass to `.where()`).
 *
 * @example
 * ```ts
 * const where = buildFilters(
 *   { projectId: filters?.projectId, status: filters?.status },
 *   { projectId: plans.projectId, status: plans.status },
 * );
 * return db.select().from(plans).where(where).orderBy(desc(plans.createdAt));
 * ```
 */
export function buildFilters(
  filters: Record<string, FilterValue>,
  columnMap: Record<string, PgColumn>,
): SQL | undefined {
  const conditions: SQL[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && columnMap[key]) {
      conditions.push(eq(columnMap[key], value));
    }
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}
