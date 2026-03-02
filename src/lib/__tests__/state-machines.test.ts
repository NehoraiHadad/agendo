import { describe, it, expect } from 'vitest';
import { isValidTaskTransition, TASK_TRANSITIONS } from '../state-machines';

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
  it('every task status has a transition entry', () => {
    const allStatuses = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
    for (const status of allStatuses) {
      expect(TASK_TRANSITIONS).toHaveProperty(status);
    }
  });
});
