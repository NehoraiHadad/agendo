/**
 * Phase 1, Agent G2a — demo mode shadows for artifact-service.
 *
 * Tests the demo shadow module directly (no env stubbing, no DB mock needed).
 * Also tests that the branch in artifact-service.ts fires before any DB access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Direct demo module tests -----------------------------------------------

describe('artifact-service.demo — shape parity', () => {
  it('getArtifact returns a valid artifact shape for known id', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const result = await demo.getArtifact('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb');
    expect(typeof result!.title).toBe('string');
    expect(['html', 'svg']).toContain(result!.type);
    expect(typeof result!.content).toBe('string');
    expect(result!.createdAt).toBeInstanceOf(Date);
  });

  it('getArtifact returns null for unknown id', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const result = await demo.getArtifact('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('listArtifactsBySession returns artifacts for Claude session', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const results = await demo.listArtifactsBySession('77777777-7777-4777-a777-777777777777');
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    results.forEach((a) => {
      expect(a.sessionId).toBe('77777777-7777-4777-a777-777777777777');
      expect(typeof a.id).toBe('string');
      expect(typeof a.title).toBe('string');
      expect(['html', 'svg']).toContain(a.type);
      expect(typeof a.content).toBe('string');
      expect(a.createdAt).toBeInstanceOf(Date);
    });
  });

  it('listArtifactsBySession returns empty array for unknown session', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const results = await demo.listArtifactsBySession('00000000-0000-0000-0000-000000000000');
    expect(results).toEqual([]);
  });

  it('listArtifactsByPlan returns empty array for unknown plan', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const results = await demo.listArtifactsByPlan('00000000-0000-0000-0000-000000000000');
    expect(results).toEqual([]);
  });

  it('artifacts are ordered by createdAt (ascending) in listArtifactsBySession', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const results = await demo.listArtifactsBySession('77777777-7777-4777-a777-777777777777');
    for (let i = 1; i < results.length; i++) {
      expect(results[i].createdAt.getTime()).toBeGreaterThanOrEqual(
        results[i - 1].createdAt.getTime(),
      );
    }
  });
});

describe('artifact-service.demo — mutation stubs', () => {
  it('createArtifact returns an artifact-shaped stub', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const result = await demo.createArtifact({
      sessionId: '77777777-7777-4777-a777-777777777777',
      planId: null,
      title: 'Test artifact',
      type: 'html',
      content: '<p>hello</p>',
    });
    expect(typeof result.id).toBe('string');
    expect(result.title).toBe('Test artifact');
    expect(result.type).toBe('html');
    expect(result.content).toBe('<p>hello</p>');
    expect(result.sessionId).toBe('77777777-7777-4777-a777-777777777777');
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('createArtifact two calls produce different ids', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const a = await demo.createArtifact({ title: 'A', type: 'html', content: '<p>a</p>' });
    const b = await demo.createArtifact({ title: 'B', type: 'svg', content: '<svg/>' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('artifact-service.demo — stable output', () => {
  it('getArtifact is deterministic for same id', async () => {
    const demo = await import('@/lib/services/artifact-service.demo');
    const id = 'bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb';
    const a = await demo.getArtifact(id);
    const b = await demo.getArtifact(id);
    expect(a?.id).toBe(b?.id);
    expect(a?.title).toBe(b?.title);
  });
});

// ---- DB is never touched when demo mode is on --------------------------------

const { mockDb: mockDbArtifact } = vi.hoisted(() => ({
  mockDb: new Proxy(
    {},
    {
      get() {
        throw new Error('DB accessed in demo mode — short-circuit failed');
      },
    },
  ),
}));

vi.mock('@/lib/db', () => ({ db: mockDbArtifact }));

describe('artifact-service — short-circuit before DB in demo mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does not access db when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    const svc = await import('@/lib/services/artifact-service');
    await expect(svc.getArtifact('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb')).resolves.toBeDefined();
    vi.unstubAllEnvs();
  });
});
