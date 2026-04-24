/**
 * Phase 1, Agent G2a — demo mode shadows for snapshot-service.
 *
 * Tests the demo shadow module directly and the short-circuit in the real service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContextSnapshot } from '@/lib/types';

// ---- Direct demo module tests -----------------------------------------------

describe('snapshot-service.demo — shape parity', () => {
  it('getSnapshot returns a valid ContextSnapshot for known id', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const result = await demo.getSnapshot('cccccccc-cccc-4001-c001-cccccccccccc');
    const _: ContextSnapshot = result satisfies ContextSnapshot;
    expect(result.id).toBe('cccccccc-cccc-4001-c001-cccccccccccc');
    expect(typeof result.name).toBe('string');
    expect(typeof result.summary).toBe('string');
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(typeof result.projectId).toBe('string');
    expect(typeof result.keyFindings).toBe('object');
    expect(Array.isArray(result.keyFindings.filesExplored)).toBe(true);
    expect(Array.isArray(result.keyFindings.findings)).toBe(true);
  });

  it('getSnapshot throws NotFoundError for unknown id', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    await expect(demo.getSnapshot('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('listSnapshots returns ContextSnapshot[] filtered by projectId', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const projectId = '44444444-4444-4444-a444-444444444444';
    const results = await demo.listSnapshots({ projectId });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    results.forEach((s: ContextSnapshot) => {
      expect(s.projectId).toBe(projectId);
      expect(typeof s.name).toBe('string');
      expect(typeof s.summary).toBe('string');
      expect(s.createdAt).toBeInstanceOf(Date);
    });
  });

  it('listSnapshots returns all fixtures when no filters', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const results = await demo.listSnapshots();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it('listSnapshots respects limit', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const results = await demo.listSnapshots({ limit: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('listSnapshots returns newest first (desc createdAt)', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const results = await demo.listSnapshots();
    for (let i = 1; i < results.length; i++) {
      expect(results[i].createdAt.getTime()).toBeLessThanOrEqual(
        results[i - 1].createdAt.getTime(),
      );
    }
  });
});

describe('snapshot-service.demo — mutation stubs', () => {
  it('createSnapshot returns a ContextSnapshot stub with generated id', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const result = await demo.createSnapshot({
      projectId: '44444444-4444-4444-a444-444444444444',
      sessionId: '77777777-7777-4777-a777-777777777777',
      name: 'Test snapshot',
      summary: 'A brief test summary for demo mode.',
    });
    const _: ContextSnapshot = result satisfies ContextSnapshot;
    expect(typeof result.id).toBe('string');
    expect(result.name).toBe('Test snapshot');
    expect(result.summary).toBe('A brief test summary for demo mode.');
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('createSnapshot two calls produce different ids', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const a = await demo.createSnapshot({
      projectId: '44444444-4444-4444-a444-444444444444',
      name: 'A',
      summary: 'summary A',
    });
    const b = await demo.createSnapshot({
      projectId: '44444444-4444-4444-a444-444444444444',
      name: 'B',
      summary: 'summary B',
    });
    expect(a.id).not.toBe(b.id);
  });

  it('updateSnapshot returns merged ContextSnapshot shape', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const result = await demo.updateSnapshot('cccccccc-cccc-4001-c001-cccccccccccc', {
      name: 'Updated name',
    });
    const _: ContextSnapshot = result satisfies ContextSnapshot;
    expect(result.name).toBe('Updated name');
    expect(result.id).toBe('cccccccc-cccc-4001-c001-cccccccccccc');
  });

  it('deleteSnapshot returns void without errors', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const result = await demo.deleteSnapshot('cccccccc-cccc-4001-c001-cccccccccccc');
    expect(result).toBeUndefined();
  });

  it('resumeFromSnapshot returns { sessionId: string } stub', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const result = await demo.resumeFromSnapshot('cccccccc-cccc-4001-c001-cccccccccccc', {
      agentId: '11111111-1111-4111-a111-111111111111',
    });
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
  });
});

describe('snapshot-service.demo — stable output', () => {
  it('getSnapshot is deterministic for same id', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const id = 'cccccccc-cccc-4001-c001-cccccccccccc';
    const a = await demo.getSnapshot(id);
    const b = await demo.getSnapshot(id);
    expect(a.id).toBe(b.id);
    expect(a.name).toBe(b.name);
    expect(a.summary).toBe(b.summary);
  });

  it('listSnapshots({ projectId }) returns same results on repeated calls', async () => {
    const demo = await import('@/lib/services/snapshot-service.demo');
    const projectId = '44444444-4444-4444-a444-444444444444';
    const a = await demo.listSnapshots({ projectId });
    const b = await demo.listSnapshots({ projectId });
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });
});

// ---- DB is never touched when demo mode is on --------------------------------

const { mockDb: mockDbSnapshot } = vi.hoisted(() => ({
  mockDb: new Proxy(
    {},
    {
      get() {
        throw new Error('DB accessed in demo mode — short-circuit failed');
      },
    },
  ),
}));

vi.mock('@/lib/db', () => ({ db: mockDbSnapshot }));

describe('snapshot-service — short-circuit before DB in demo mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not access db when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    const svc = await import('@/lib/services/snapshot-service');
    await expect(svc.getSnapshot('cccccccc-cccc-4001-c001-cccccccccccc')).resolves.toBeDefined();
    vi.unstubAllEnvs();
  });
});
