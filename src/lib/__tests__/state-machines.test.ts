import { describe, it, expect } from 'vitest';
import {
  isValidTaskTransition,
  isValidExecutionTransition,
  isTerminalExecutionStatus,
  TASK_TRANSITIONS,
  EXECUTION_TRANSITIONS,
} from '../state-machines';

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

describe('Execution Status Transitions', () => {
  it('allows queued -> running', () => {
    expect(isValidExecutionTransition('queued', 'running')).toBe(true);
  });

  it('allows queued -> cancelled', () => {
    expect(isValidExecutionTransition('queued', 'cancelled')).toBe(true);
  });

  it('rejects queued -> succeeded', () => {
    expect(isValidExecutionTransition('queued', 'succeeded')).toBe(false);
  });

  it('allows running -> cancelling', () => {
    expect(isValidExecutionTransition('running', 'cancelling')).toBe(true);
  });

  it('allows running -> succeeded', () => {
    expect(isValidExecutionTransition('running', 'succeeded')).toBe(true);
  });

  it('allows running -> failed', () => {
    expect(isValidExecutionTransition('running', 'failed')).toBe(true);
  });

  it('allows running -> timed_out', () => {
    expect(isValidExecutionTransition('running', 'timed_out')).toBe(true);
  });

  it('allows cancelling -> cancelled', () => {
    expect(isValidExecutionTransition('cancelling', 'cancelled')).toBe(true);
  });

  it('allows cancelling -> failed', () => {
    expect(isValidExecutionTransition('cancelling', 'failed')).toBe(true);
  });

  it('rejects cancelling -> succeeded', () => {
    expect(isValidExecutionTransition('cancelling', 'succeeded')).toBe(false);
  });
});

describe('Terminal Execution Statuses', () => {
  it('succeeded is terminal', () => {
    expect(isTerminalExecutionStatus('succeeded')).toBe(true);
  });

  it('failed is terminal', () => {
    expect(isTerminalExecutionStatus('failed')).toBe(true);
  });

  it('cancelled is terminal', () => {
    expect(isTerminalExecutionStatus('cancelled')).toBe(true);
  });

  it('timed_out is terminal', () => {
    expect(isTerminalExecutionStatus('timed_out')).toBe(true);
  });

  it('running is NOT terminal', () => {
    expect(isTerminalExecutionStatus('running')).toBe(false);
  });

  it('queued is NOT terminal', () => {
    expect(isTerminalExecutionStatus('queued')).toBe(false);
  });

  it('cancelling is NOT terminal', () => {
    expect(isTerminalExecutionStatus('cancelling')).toBe(false);
  });
});

describe('Transition Table Completeness', () => {
  it('every task status has a transition entry', () => {
    const allStatuses = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
    for (const status of allStatuses) {
      expect(TASK_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('every execution status has a transition entry', () => {
    const allStatuses = [
      'queued',
      'running',
      'cancelling',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
    ] as const;
    for (const status of allStatuses) {
      expect(EXECUTION_TRANSITIONS).toHaveProperty(status);
    }
  });
});
