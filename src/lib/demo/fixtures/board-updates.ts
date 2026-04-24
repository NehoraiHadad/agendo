/**
 * Board update event generator for demo mode SSE replay.
 *
 * Produces an initial snapshot followed by incremental task_updated events,
 * matching the exact payload envelope emitted by `/api/sse/board/route.ts`.
 *
 * Envelope types:
 *   - snapshot: { type: 'snapshot'; tasks: TaskBoardItem[] }   — sent once at t=0
 *   - task_updated: { type: 'task_updated'; task: TaskBoardItem } — sent every intervalMs
 *
 * The generator cycles through a small set of demo tasks, advancing each
 * through the state machine: todo → in_progress → done → todo.
 */

import { DEMO_TASKS } from '@/lib/services/task-service.demo';
import type { TaskBoardItem } from '@/lib/services/task-service';
import type { Task, TaskStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Payload types — match /api/sse/board/route.ts byte-for-byte
// ---------------------------------------------------------------------------

export type SnapshotPayload = {
  type: 'snapshot';
  tasks: TaskBoardItem[];
};

export type TaskUpdatedPayload = {
  type: 'task_updated';
  task: TaskBoardItem;
};

export type BoardUpdatePayload = SnapshotPayload | TaskUpdatedPayload;

export interface BoardUpdateEvent {
  /** Milliseconds from the generator start. */
  atMs: number;
  /** Envelope matching what `/api/sse/board` normally sends. */
  payload: BoardUpdatePayload;
}

// ---------------------------------------------------------------------------
// State machine: valid next-status transitions
// ---------------------------------------------------------------------------

const STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus> = {
  todo: 'in_progress',
  in_progress: 'done',
  done: 'todo',
  blocked: 'in_progress',
  cancelled: 'todo', // edge case — not used in cycling tasks below
};

// ---------------------------------------------------------------------------
// Task IDs to cycle through (safe subset — not cancelled, not blocked)
// We rotate through these 6 tasks: T05, T06, T07, T10, T11, T12
// (mix of in_progress and todo tasks to keep the board lively)
// ---------------------------------------------------------------------------

const CYCLING_TASK_IDS = [
  'aaaaaaaa-aaaa-4005-a005-aaaaaaaaaaaa', // T05 — in_progress
  'aaaaaaaa-aaaa-4006-a006-aaaaaaaaaaaa', // T06 — in_progress
  'aaaaaaaa-aaaa-4007-a007-aaaaaaaaaaaa', // T07 — in_progress
  'aaaaaaaa-aaaa-4010-a010-aaaaaaaaaaaa', // T10 — todo
  'aaaaaaaa-aaaa-4011-a011-aaaaaaaaaaaa', // T11 — todo
  'aaaaaaaa-aaaa-4012-a012-aaaaaaaaaaaa', // T12 — todo
] as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute subtask counts for a given task against the full fixture list. */
function computeSubtaskCounts(taskId: string): { total: number; done: number } {
  const children = DEMO_TASKS.filter((t) => t.parentTaskId === taskId);
  return {
    total: children.length,
    done: children.filter((t) => t.status === 'done').length,
  };
}

function toTaskBoardItem(task: Task): TaskBoardItem {
  const { total, done } = computeSubtaskCounts(task.id);
  return { ...task, subtaskTotal: total, subtaskDone: done };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produces an initial board snapshot followed by incremental task_updated
 * events. Cycles through a predefined set of demo tasks, advancing one task
 * through the status state machine every `intervalMs` milliseconds.
 *
 * @param opts.intervalMs  Milliseconds between updates (default 8000).
 * @param opts.startAtMs   Starting offset for atMs values (default 0).
 * @param opts.count       Maximum number of task_updated events to emit (default 50).
 * @returns                Array of BoardUpdateEvent (1 snapshot + count updates).
 */
export function generateBoardUpdates(opts?: {
  intervalMs?: number;
  startAtMs?: number;
  count?: number;
}): BoardUpdateEvent[] {
  const intervalMs = opts?.intervalMs ?? 8000;
  const startAtMs = opts?.startAtMs ?? 0;
  const count = opts?.count ?? 50;

  const events: BoardUpdateEvent[] = [];

  // --- 1. Initial snapshot ---
  const allTaskBoardItems = DEMO_TASKS.map(toTaskBoardItem);
  events.push({
    atMs: startAtMs,
    payload: {
      type: 'snapshot',
      tasks: allTaskBoardItems,
    },
  });

  if (count === 0) {
    return events;
  }

  // --- 2. Build a mutable status map for cycling tasks ---
  const taskStatusMap = new Map<string, TaskStatus>();
  for (const id of CYCLING_TASK_IDS) {
    const task = DEMO_TASKS.find((t) => t.id === id);
    if (task) {
      taskStatusMap.set(id, task.status);
    }
  }

  // --- 3. Build a mutable task map for full task data ---
  const taskDataMap = new Map<string, Task>();
  for (const task of DEMO_TASKS) {
    taskDataMap.set(task.id, { ...task });
  }

  // --- 4. Emit incremental updates ---
  for (let i = 0; i < count; i++) {
    const cycleIndex = i % CYCLING_TASK_IDS.length;
    const taskId = CYCLING_TASK_IDS[cycleIndex];

    const currentStatus = taskStatusMap.get(taskId) ?? 'todo';
    const nextStatus = STATUS_TRANSITIONS[currentStatus] ?? 'todo';

    // Update the mutable tracking map
    taskStatusMap.set(taskId, nextStatus);

    // Build an updated task row
    const baseTask = taskDataMap.get(taskId);
    if (!baseTask) continue;

    const updatedTask: Task = {
      ...baseTask,
      status: nextStatus,
      updatedAt: new Date(startAtMs + (i + 1) * intervalMs),
    };

    // Persist the updated task so subsequent reads see the latest status
    taskDataMap.set(taskId, updatedTask);

    events.push({
      atMs: startAtMs + (i + 1) * intervalMs,
      payload: {
        type: 'task_updated',
        task: toTaskBoardItem(updatedTask),
      },
    });
  }

  return events;
}
