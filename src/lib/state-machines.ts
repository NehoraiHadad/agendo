import { createStatusMachine } from '@/lib/utils/status-machine';
import type { TaskStatus } from './types';

/**
 * Task status machine — validates transitions between task statuses.
 */
export const taskMachine = createStatusMachine<TaskStatus>(
  {
    todo: ['in_progress', 'cancelled', 'blocked'],
    in_progress: ['done', 'blocked', 'cancelled', 'todo'],
    blocked: ['todo', 'in_progress', 'cancelled'],
    done: ['todo'], // reopen
    cancelled: ['todo'], // reopen
  },
  'task',
);

/** Terminal statuses that cannot transition further */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set();
// Note: tasks have no truly terminal states -- done and cancelled can reopen to todo

// ---------------------------------------------------------------------------
// Backward-compat re-exports
// ---------------------------------------------------------------------------

/** @deprecated Use `taskMachine.isValid()` instead */
export function isValidTaskTransition(current: TaskStatus, next: TaskStatus): boolean {
  return taskMachine.isValid(current, next);
}

/** @deprecated Use `taskMachine` directly instead */
export const TASK_TRANSITIONS = taskMachine;
