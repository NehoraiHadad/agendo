import { describe, it, expect } from 'vitest';
import { isValidTaskTransition, taskMachine } from '../state-machines';
import { createStatusMachine } from '@/lib/utils/status-machine';
import { ConflictError } from '@/lib/errors';

describe('Task Status Transitions', () => {
  it('allows todo -> in_progress', () => {
    expect(isValidTaskTransition('todo', 'in_progress')).toBe(true);
  });

  it('allows todo -> cancelled', () => {
    expect(isValidTaskTransition('todo', 'cancelled')).toBe(true);
  });

  it('allows todo -> blocked', () => {
    expect(isValidTaskTransition('todo', 'blocked')).toBe(true);
  });

  it('rejects todo -> done (must go through in_progress)', () => {
    expect(isValidTaskTransition('todo', 'done')).toBe(false);
  });

  it('allows in_progress -> done', () => {
    expect(isValidTaskTransition('in_progress', 'done')).toBe(true);
  });

  it('allows in_progress -> todo (revert)', () => {
    expect(isValidTaskTransition('in_progress', 'todo')).toBe(true);
  });

  it('allows done -> todo (reopen)', () => {
    expect(isValidTaskTransition('done', 'todo')).toBe(true);
  });

  it('rejects done -> in_progress (must reopen to todo first)', () => {
    expect(isValidTaskTransition('done', 'in_progress')).toBe(false);
  });

  it('allows cancelled -> todo (reopen)', () => {
    expect(isValidTaskTransition('cancelled', 'todo')).toBe(true);
  });

  it('rejects cancelled -> done', () => {
    expect(isValidTaskTransition('cancelled', 'done')).toBe(false);
  });

  it('allows blocked -> todo', () => {
    expect(isValidTaskTransition('blocked', 'todo')).toBe(true);
  });

  it('allows blocked -> in_progress', () => {
    expect(isValidTaskTransition('blocked', 'in_progress')).toBe(true);
  });
});

describe('Transition Table Completeness', () => {
  it('every task status has valid targets', () => {
    const allStatuses = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
    for (const status of allStatuses) {
      expect(taskMachine.validTargets(status).length).toBeGreaterThan(0);
    }
  });
});

describe('createStatusMachine', () => {
  const machine = createStatusMachine(
    { open: ['closed', 'paused'], closed: ['open'], paused: ['open'] },
    'test',
  );

  it('isValid returns true for allowed transitions', () => {
    expect(machine.isValid('open', 'closed')).toBe(true);
    expect(machine.isValid('open', 'paused')).toBe(true);
    expect(machine.isValid('closed', 'open')).toBe(true);
  });

  it('isValid returns false for disallowed transitions', () => {
    expect(machine.isValid('closed', 'paused')).toBe(false);
    expect(machine.isValid('paused', 'closed')).toBe(false);
  });

  it('isValid returns false for unknown statuses', () => {
    expect(machine.isValid('unknown' as never, 'open')).toBe(false);
  });

  it('assert throws ConflictError on invalid transition', () => {
    expect(() => machine.assert('closed', 'paused')).toThrow(ConflictError);
    expect(() => machine.assert('closed', 'paused')).toThrow(
      'Invalid test status transition: closed → paused',
    );
  });

  it('assert does not throw on valid transition', () => {
    expect(() => machine.assert('open', 'closed')).not.toThrow();
  });

  it('validTargets returns correct array', () => {
    expect(machine.validTargets('open')).toEqual(['closed', 'paused']);
    expect(machine.validTargets('closed')).toEqual(['open']);
  });

  it('validTargets returns empty array for unknown status', () => {
    expect(machine.validTargets('unknown' as never)).toEqual([]);
  });
});
