/**
 * Demo mode tests for dashboard-service.
 *
 * Tests the demo shadow module directly and verifies the isDemoMode() branch
 * in the real service fires before any DB access.
 */

import { describe, it, expect, vi } from 'vitest';
import type { DashboardStats } from '@/lib/services/dashboard-service';

// ---- Direct demo module tests -----------------------------------------------

describe('dashboard-service.demo — shape parity', () => {
  it('getDashboardStats returns correct shape', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    const _: DashboardStats = result satisfies DashboardStats;
    expect(typeof result.totalTasks).toBe('number');
    expect(typeof result.projectCount).toBe('number');
    expect(Array.isArray(result.recentEvents)).toBe(true);
    expect(Array.isArray(result.agentHealth)).toBe(true);
    expect(typeof result.taskCountsByStatus).toBe('object');
  });

  it('taskCountsByStatus matches fixture narrative (5+3+2+4+1=15)', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    expect(result.taskCountsByStatus.todo).toBe(5);
    expect(result.taskCountsByStatus.in_progress).toBe(3);
    expect(result.taskCountsByStatus.blocked).toBe(2);
    expect(result.taskCountsByStatus.done).toBe(4);
    expect(result.taskCountsByStatus.cancelled).toBe(1);
  });

  it('totalTasks equals 15', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    expect(result.totalTasks).toBe(15);
  });

  it('projectCount equals 3', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    expect(result.projectCount).toBe(3);
  });

  it('agentHealth contains 3 entries (Claude, Codex, Gemini)', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    expect(result.agentHealth).toHaveLength(3);
    result.agentHealth.forEach((entry) => {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.slug).toBe('string');
      expect(typeof entry.isActive).toBe('boolean');
      expect(typeof entry.maxConcurrent).toBe('number');
    });
  });

  it('agentHealth IDs match canonical demo agent UUIDs', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    const ids = result.agentHealth.map((e) => e.id);
    expect(ids).toContain('11111111-1111-4111-a111-111111111111');
    expect(ids).toContain('22222222-2222-4222-a222-222222222222');
    expect(ids).toContain('33333333-3333-4333-a333-333333333333');
  });

  it('workerStatus is non-null and isOnline=true', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    expect(result.workerStatus).not.toBeNull();
    expect(result.workerStatus!.isOnline).toBe(true);
    expect(result.workerStatus!.lastSeenAt).toBeInstanceOf(Date);
  });

  it('recentEvents contains events with correct shape', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    expect(result.recentEvents.length).toBeGreaterThan(0);
    result.recentEvents.forEach((event) => {
      expect(typeof event.id).toBe('number');
      expect(typeof event.taskId).toBe('string');
      expect(typeof event.eventType).toBe('string');
      expect(typeof event.actorType).toBe('string');
      expect(typeof event.payload).toBe('object');
      expect(event.createdAt).toBeInstanceOf(Date);
    });
  });

  it('recentEvents taskIds reference canonical task UUIDs', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const result = await demo.getDashboardStats();
    // All task IDs should start with 'aaaaaaaa-aaaa-4'
    result.recentEvents.forEach((event) => {
      expect(event.taskId).toMatch(/^aaaaaaaa-aaaa-4/);
    });
  });
});

describe('dashboard-service.demo — stable output for reads', () => {
  it('getDashboardStats is deterministic across calls', async () => {
    const demo = await import('@/lib/services/dashboard-service.demo');
    const a = await demo.getDashboardStats();
    const b = await demo.getDashboardStats();
    expect(a.totalTasks).toBe(b.totalTasks);
    expect(a.projectCount).toBe(b.projectCount);
    expect(a.workerStatus?.isOnline).toBe(b.workerStatus?.isOnline);
    expect(a.workerStatus?.lastSeenAt.toISOString()).toBe(b.workerStatus?.lastSeenAt.toISOString());
  });
});

// ---- DB is never touched when demo mode is on --------------------------------

const { mockDb } = vi.hoisted(() => ({
  mockDb: new Proxy(
    {},
    {
      get() {
        throw new Error('DB accessed in demo mode — short-circuit failed');
      },
    },
  ),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

describe('dashboard-service — short-circuit before DB in demo mode', () => {
  it('does not access db when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.resetModules();

    const svc = await import('@/lib/services/dashboard-service');
    await expect(svc.getDashboardStats()).resolves.toBeDefined();

    vi.unstubAllEnvs();
  });
});
