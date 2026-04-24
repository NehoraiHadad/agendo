/**
 * Demo-mode shadow for db-helpers.
 *
 * `getById` should never be called in demo mode — all entity lookups are
 * handled by the individual service demos that return in-memory fixtures.
 * If called unexpectedly, throw NotFoundError so the caller fails loudly
 * rather than silently returning a malformed row.
 */

import { NotFoundError } from '@/lib/errors';

export async function getById(_table: unknown, id: string, entityName: string): Promise<never> {
  throw new NotFoundError(entityName, id);
}
