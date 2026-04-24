import { describe, it, expect } from 'vitest';
import { getById } from '../db-helpers.demo';
import { NotFoundError } from '@/lib/errors';

describe('db-helpers.demo', () => {
  it('getById always throws NotFoundError with the entity name and id', async () => {
    await expect(getById({}, 'some-uuid', 'Session')).rejects.toThrow(NotFoundError);
  });

  it('error message includes entity name and id', async () => {
    await expect(getById({}, 'abc-123', 'Task')).rejects.toThrow('Task');
  });

  it('never returns a value — throws for every call', async () => {
    await expect(getById(null, '11111111-1111-4111-a111-111111111111', 'Agent')).rejects.toThrow(
      NotFoundError,
    );
  });
});
