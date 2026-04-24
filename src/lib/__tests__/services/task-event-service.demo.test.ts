/**
 * Phase 1, Agent G2a — demo mode shadows for task-event-service.
 *
 * Tests the demo shadow module directly and the short-circuit in the real service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskEvent } from '@/lib/types';

// ---- Direct demo module tests -----------------------------------------------

describe('task-event-service.demo — shape parity', () => {
  it('listTaskEvents returns TaskEvent[] for a task with events', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const results = await demo.listTaskEvents('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    results.forEach((e: TaskEvent) => {
      expect(e.taskId).toBe('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
      expect(typeof e.id).toBe('number');
      expect(['user', 'agent', 'system']).toContain(e.actorType);
      expect(typeof e.eventType).toBe('string');
      expect(typeof e.payload).toBe('object');
      expect(e.createdAt).toBeInstanceOf(Date);
    });
  });

  it('listTaskEvents returns empty array for unknown task', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const results = await demo.listTaskEvents('00000000-0000-0000-0000-000000000000');
    expect(results).toEqual([]);
  });

  it('listTaskEvents returns newest-first ordering', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const results = await demo.listTaskEvents('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    for (let i = 1; i < results.length; i++) {
      expect(results[i].createdAt.getTime()).toBeLessThanOrEqual(
        results[i - 1].createdAt.getTime(),
      );
    }
  });

  it('listTaskEvents respects limit parameter', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const results = await demo.listTaskEvents('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('listTaskEvents returns events spanning multiple tasks', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const results4002 = await demo.listTaskEvents('aaaaaaaa-aaaa-4002-a002-aaaaaaaaaaaa');
    const results4003 = await demo.listTaskEvents('aaaaaaaa-aaaa-4003-a003-aaaaaaaaaaaa');
    // Both should have events
    expect(results4002.length + results4003.length).toBeGreaterThan(0);
  });

  it('TaskEvent has numeric id (bigint mode number)', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const results = await demo.listTaskEvents('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    results.forEach((e) => {
      expect(Number.isInteger(e.id)).toBe(true);
    });
  });
});

describe('task-event-service.demo — mutation stubs', () => {
  it('createTaskEvent returns a TaskEvent-shaped stub', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const result = await demo.createTaskEvent({
      taskId: 'aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa',
      actorType: 'agent',
      actorId: '11111111-1111-4111-a111-111111111111',
      eventType: 'status_changed',
      payload: { from: 'todo', to: 'in_progress' },
    });
    const _: TaskEvent = result satisfies TaskEvent;
    expect(result.taskId).toBe('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(result.actorType).toBe('agent');
    expect(result.eventType).toBe('status_changed');
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(Number.isInteger(result.id)).toBe(true);
  });

  it('createTaskEvent two calls produce different ids', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const a = await demo.createTaskEvent({
      taskId: 'aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa',
      actorType: 'system',
      eventType: 'created',
    });
    const b = await demo.createTaskEvent({
      taskId: 'aaaaaaaa-aaaa-4002-a002-aaaaaaaaaaaa',
      actorType: 'system',
      eventType: 'created',
    });
    expect(a.id).not.toBe(b.id);
  });
});

describe('task-event-service.demo — stable output', () => {
  it('listTaskEvents is deterministic for same taskId', async () => {
    const demo = await import('@/lib/services/task-event-service.demo');
    const id = 'aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa';
    const a = await demo.listTaskEvents(id);
    const b = await demo.listTaskEvents(id);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });
});

// ---- DB is never touched when demo mode is on --------------------------------

const { mockDb: mockDbTaskEvent } = vi.hoisted(() => ({
  mockDb: new Proxy(
    {},
    {
      get() {
        throw new Error('DB accessed in demo mode — short-circuit failed');
      },
    },
  ),
}));

vi.mock('@/lib/db', () => ({ db: mockDbTaskEvent }));

describe('task-event-service — short-circuit before DB in demo mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not access db when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    const svc = await import('@/lib/services/task-event-service');
    await expect(svc.listTaskEvents('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa')).resolves.toBeDefined();
    vi.unstubAllEnvs();
  });
});
