import type { TaskStatus, ExecutionStatus } from './types';

/**
 * Valid task status transitions.
 * Key = current status, Value = set of valid next statuses.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set(['in_progress', 'cancelled', 'blocked']),
  in_progress: new Set(['done', 'blocked', 'cancelled', 'todo']),
  blocked: new Set(['todo', 'in_progress', 'cancelled']),
  done: new Set(['todo']),       // reopen
  cancelled: new Set(['todo']),  // reopen
};

/**
 * Valid execution status transitions.
 * Key = current status, Value = set of valid next statuses.
 */
export const EXECUTION_TRANSITIONS: Record<ExecutionStatus, ReadonlySet<ExecutionStatus>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['cancelling', 'succeeded', 'failed', 'timed_out']),
  cancelling: new Set(['cancelled', 'failed']),
  succeeded: new Set(),    // terminal
  failed: new Set(),       // terminal
  cancelled: new Set(),    // terminal
  timed_out: new Set(),    // terminal
};

/** Terminal statuses that cannot transition further */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set();
// Note: tasks have no truly terminal states -- done and cancelled can reopen to todo

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  'succeeded', 'failed', 'cancelled', 'timed_out',
]);

/**
 * Check if a status transition is valid.
 * @returns true if transitioning from `current` to `next` is allowed
 */
export function isValidTaskTransition(current: TaskStatus, next: TaskStatus): boolean {
  return TASK_TRANSITIONS[current].has(next);
}

export function isValidExecutionTransition(current: ExecutionStatus, next: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[current].has(next);
}

/**
 * Check if an execution status is terminal (no further transitions possible).
 */
export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status);
}
