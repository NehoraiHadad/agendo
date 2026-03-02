import type { TaskStatus } from './types';

/**
 * Valid task status transitions.
 * Key = current status, Value = set of valid next statuses.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set(['in_progress', 'cancelled', 'blocked']),
  in_progress: new Set(['done', 'blocked', 'cancelled', 'todo']),
  blocked: new Set(['todo', 'in_progress', 'cancelled']),
  done: new Set(['todo']), // reopen
  cancelled: new Set(['todo']), // reopen
};

/** Terminal statuses that cannot transition further */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set();
// Note: tasks have no truly terminal states -- done and cancelled can reopen to todo

/**
 * Check if a status transition is valid.
 * @returns true if transitioning from `current` to `next` is allowed
 */
export function isValidTaskTransition(current: TaskStatus, next: TaskStatus): boolean {
  return TASK_TRANSITIONS[current].has(next);
}
