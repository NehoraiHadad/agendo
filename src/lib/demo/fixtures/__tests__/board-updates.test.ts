/**
 * Tests for the board-updates generator.
 * Verifies snapshot structure, incremental updates, atMs spacing, and state machine validity.
 */

import { describe, it, expect } from 'vitest';
import { generateBoardUpdates } from '../board-updates';
import { DEMO_TASKS } from '@/lib/services/task-service.demo';
import type { TaskBoardItem } from '@/lib/services/task-service';

const VALID_STATUSES = new Set(['todo', 'in_progress', 'done', 'blocked', 'cancelled']);

const STATUS_MACHINE: Record<string, string[]> = {
  todo: ['in_progress'],
  in_progress: ['done', 'blocked'],
  blocked: ['in_progress', 'todo'],
  done: ['todo'],
  cancelled: [],
};

describe('generateBoardUpdates()', () => {
  it('returns an array', () => {
    const events = generateBoardUpdates({ count: 0 });
    expect(Array.isArray(events)).toBe(true);
  });

  it('with count=0 returns exactly 1 event (snapshot only)', () => {
    const events = generateBoardUpdates({ count: 0 });
    expect(events).toHaveLength(1);
  });

  it('with count=3 returns exactly 4 events (1 snapshot + 3 updates)', () => {
    const events = generateBoardUpdates({ count: 3 });
    expect(events).toHaveLength(4);
  });

  it('first event is a snapshot at atMs=0', () => {
    const events = generateBoardUpdates({ count: 1 });
    const first = events[0];
    expect(first.atMs).toBe(0);
    expect(first.payload.type).toBe('snapshot');
  });

  it('snapshot contains all 15 demo tasks', () => {
    const events = generateBoardUpdates({ count: 1 });
    const snapshot = events[0].payload;
    expect(snapshot.type).toBe('snapshot');
    expect((snapshot as { type: 'snapshot'; tasks: TaskBoardItem[] }).tasks).toHaveLength(
      DEMO_TASKS.length,
    );
  });

  it('subsequent events are task_updated type', () => {
    const events = generateBoardUpdates({ count: 3 });
    for (const ev of events.slice(1)) {
      expect(ev.payload.type).toBe('task_updated');
    }
  });

  it('events are in atMs order', () => {
    const events = generateBoardUpdates({ count: 5 });
    for (let i = 1; i < events.length; i++) {
      expect(events[i].atMs).toBeGreaterThan(events[i - 1].atMs);
    }
  });

  it('default intervalMs is 8000ms — each update is 8000ms after the previous', () => {
    const events = generateBoardUpdates({ count: 3 });
    // event[0] = snapshot at 0, event[1] at 8000, event[2] at 16000, event[3] at 24000
    expect(events[1].atMs).toBe(8000);
    expect(events[2].atMs).toBe(16000);
    expect(events[3].atMs).toBe(24000);
  });

  it('custom intervalMs is respected', () => {
    const events = generateBoardUpdates({ count: 2, intervalMs: 5000 });
    expect(events[1].atMs).toBe(5000);
    expect(events[2].atMs).toBe(10000);
  });

  it('startAtMs offsets the whole sequence', () => {
    const events = generateBoardUpdates({ count: 2, startAtMs: 1000, intervalMs: 3000 });
    expect(events[0].atMs).toBe(1000);
    expect(events[1].atMs).toBe(4000);
    expect(events[2].atMs).toBe(7000);
  });

  it('each task_updated payload has a valid status', () => {
    const events = generateBoardUpdates({ count: 10 });
    for (const ev of events.slice(1)) {
      const task = (ev.payload as { type: 'task_updated'; task: TaskBoardItem }).task;
      expect(VALID_STATUSES.has(task.status)).toBe(true);
    }
  });

  it('each task_updated toStatus is reachable from the previous fromStatus', () => {
    const events = generateBoardUpdates({ count: 10 });
    // Track current status per task
    const statusMap = new Map<string, string>();
    for (const ev of events.slice(1)) {
      const task = (ev.payload as { type: 'task_updated'; task: TaskBoardItem }).task;
      const prevStatus = statusMap.get(task.id);
      if (prevStatus !== undefined) {
        const reachable = STATUS_MACHINE[prevStatus] ?? [];
        expect(reachable).toContain(task.status);
      }
      statusMap.set(task.id, task.status);
    }
  });

  it('no two consecutive task_updated events affect the same task', () => {
    const events = generateBoardUpdates({ count: 10 });
    const updateEvents = events.slice(1);
    for (let i = 1; i < updateEvents.length; i++) {
      const prevTaskId = (
        updateEvents[i - 1].payload as { type: 'task_updated'; task: TaskBoardItem }
      ).task.id;
      const currTaskId = (updateEvents[i].payload as { type: 'task_updated'; task: TaskBoardItem })
        .task.id;
      expect(currTaskId).not.toBe(prevTaskId);
    }
  });

  it('default count is 50, producing 51 events', () => {
    const events = generateBoardUpdates();
    expect(events).toHaveLength(51);
  });

  it('task_updated task has subtaskTotal and subtaskDone fields (TaskBoardItem shape)', () => {
    const events = generateBoardUpdates({ count: 3 });
    for (const ev of events.slice(1)) {
      const task = (ev.payload as { type: 'task_updated'; task: TaskBoardItem }).task;
      expect(typeof task.subtaskTotal).toBe('number');
      expect(typeof task.subtaskDone).toBe('number');
    }
  });
});
