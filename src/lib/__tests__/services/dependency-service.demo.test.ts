/**
 * Phase 1, Agent G2a — demo mode shadows for dependency-service.
 *
 * Tests the demo shadow module directly and the short-circuit in the real service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Direct demo module tests -----------------------------------------------

describe('dependency-service.demo — shape parity', () => {
  it('listDependencies returns { id, title, status }[] for a task with deps', async () => {
    const demo = await import('@/lib/services/dependency-service.demo');
    // task-4004 depends on task-4003 in fixtures
    const results = await demo.listDependencies('aaaaaaaa-aaaa-4004-a004-aaaaaaaaaaaa');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    results.forEach((d) => {
      expect(typeof d.id).toBe('string');
      expect(typeof d.title).toBe('string');
      expect(typeof d.status).toBe('string');
    });
  });

  it('listDependencies returns empty array for task with no deps', async () => {
    const demo = await import('@/lib/services/dependency-service.demo');
    const results = await demo.listDependencies('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(results).toEqual([]);
  });

  it('listDependents returns { id, title, status }[] for a task that blocks others', async () => {
    const demo = await import('@/lib/services/dependency-service.demo');
    // task-4003 is blocked by others / blocks task-4004
    const results = await demo.listDependents('aaaaaaaa-aaaa-4003-a003-aaaaaaaaaaaa');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    results.forEach((d) => {
      expect(typeof d.id).toBe('string');
      expect(typeof d.title).toBe('string');
      expect(typeof d.status).toBe('string');
    });
  });

  it('listDependents returns empty array for task that blocks nothing', async () => {
    const demo = await import('@/lib/services/dependency-service.demo');
    const results = await demo.listDependents('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(results).toEqual([]);
  });
});

describe('dependency-service.demo — mutation stubs', () => {
  it('addDependency returns a { taskId, dependsOnTaskId, createdAt } row', async () => {
    const demo = await import('@/lib/services/dependency-service.demo');
    const result = await demo.addDependency(
      'aaaaaaaa-aaaa-4010-a010-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa',
    );
    expect(result.taskId).toBe('aaaaaaaa-aaaa-4010-a010-aaaaaaaaaaaa');
    expect(result.dependsOnTaskId).toBe('aaaaaaaa-aaaa-4001-a001-aaaaaaaaaaaa');
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('removeDependency returns void without errors', async () => {
    const demo = await import('@/lib/services/dependency-service.demo');
    const result = await demo.removeDependency(
      'aaaaaaaa-aaaa-4004-a004-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4003-a003-aaaaaaaaaaaa',
    );
    expect(result).toBeUndefined();
  });
});

describe('dependency-service.demo — stable output', () => {
  it('listDependencies is deterministic for same taskId', async () => {
    const demo = await import('@/lib/services/dependency-service.demo');
    const id = 'aaaaaaaa-aaaa-4004-a004-aaaaaaaaaaaa';
    const a = await demo.listDependencies(id);
    const b = await demo.listDependencies(id);
    expect(a.map((d) => d.id)).toEqual(b.map((d) => d.id));
  });
});

// ---- DB is never touched when demo mode is on --------------------------------

const { mockDb: mockDbDependency } = vi.hoisted(() => ({
  mockDb: new Proxy(
    {},
    {
      get() {
        throw new Error('DB accessed in demo mode — short-circuit failed');
      },
    },
  ),
}));

vi.mock('@/lib/db', () => ({ db: mockDbDependency }));

describe('dependency-service — short-circuit before DB in demo mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not access db when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    const svc = await import('@/lib/services/dependency-service');
    await expect(
      svc.listDependencies('aaaaaaaa-aaaa-4004-a004-aaaaaaaaaaaa'),
    ).resolves.toBeDefined();
    vi.unstubAllEnvs();
  });
});
