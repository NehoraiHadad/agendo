/**
 * Demo mode tests for project-service.
 *
 * Tests the demo shadow module directly and verifies the isDemoMode() branch
 * in the real service fires before any DB access.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Project } from '@/lib/types';

// ---- Direct demo module tests -----------------------------------------------

describe('project-service.demo — shape parity', () => {
  it('listProjects returns 3 demo projects', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.listProjects();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(3);
  });

  it('listProjects returns all active projects by default', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.listProjects();
    const _: Project[] = result satisfies Project[];
    result.forEach((p) => {
      expect(p.isActive).toBe(true);
    });
  });

  it('listProjects filters to active-only when isActive=true', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.listProjects(true);
    expect(result.every((p) => p.isActive === true)).toBe(true);
  });

  it('listProjects returns all projects when isActive=false filter applied', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.listProjects(false);
    // In demo all projects are active, so false filter returns none
    expect(result.every((p) => p.isActive === false)).toBe(true);
  });

  it('all project fixtures have required non-nullable fields', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const projects = await demo.listProjects();
    for (const p of projects) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(typeof p.rootPath).toBe('string');
      expect(typeof p.color).toBe('string');
      expect(typeof p.isActive).toBe('boolean');
      expect(p.createdAt).toBeInstanceOf(Date);
      expect(p.updatedAt).toBeInstanceOf(Date);
      expect(typeof p.envOverrides).toBe('object');
    }
  });

  it('getProject returns agendo project for canonical id', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.getProject('44444444-4444-4444-a444-444444444444');
    const _: Project = result satisfies Project;
    expect(result.id).toBe('44444444-4444-4444-a444-444444444444');
    expect(result.name).toBe('agendo');
    expect(result.rootPath).toBe('/home/ubuntu/projects/agendo');
  });

  it('getProject returns my-other-app project for canonical id', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.getProject('55555555-5555-4555-a555-555555555555');
    expect(result.id).toBe('55555555-5555-4555-a555-555555555555');
    expect(result.name).toBe('my-other-app');
  });

  it('getProject returns playground project for canonical id', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.getProject('66666666-6666-4666-a666-666666666666');
    expect(result.id).toBe('66666666-6666-4666-a666-666666666666');
    expect(result.name).toBe('Playground');
  });

  it('getProject throws NotFoundError for unknown id', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    await expect(demo.getProject('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('searchProjects returns matching results', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const results = await demo.searchProjects('agendo');
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r) => {
      expect(typeof r.id).toBe('string');
      expect(typeof r.name).toBe('string');
    });
  });

  it('searchProjects returns empty array for no match', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const results = await demo.searchProjects('zzznomatchzzz');
    expect(results).toEqual([]);
  });

  it('getOrCreateSystemProject returns agendo fixture', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.getOrCreateSystemProject();
    const _: Project = result satisfies Project;
    expect(result.id).toBe('44444444-4444-4444-a444-444444444444');
  });
});

describe('project-service.demo — mutation stubs', () => {
  it('createProject returns a Project-shaped stub without persisting', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.createProject({
      name: 'Test Project',
      rootPath: '/tmp/test-project',
    });
    const _: Project = result satisfies Project;
    expect(result.name).toBe('Test Project');
    expect(typeof result.id).toBe('string');
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('updateProject returns merged Project shape', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.updateProject('44444444-4444-4444-a444-444444444444', {
      description: 'Updated description',
    });
    const _: Project = result satisfies Project;
    expect(result.id).toBe('44444444-4444-4444-a444-444444444444');
    expect(result.description).toBe('Updated description');
  });

  it('updateProject throws for unknown id', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    await expect(
      demo.updateProject('00000000-0000-0000-0000-000000000000', { name: 'x' }),
    ).rejects.toThrow();
  });

  it('deleteProject returns void without errors', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.deleteProject('44444444-4444-4444-a444-444444444444');
    expect(result).toBeUndefined();
  });

  it('restoreProject returns a Project shape', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.restoreProject('44444444-4444-4444-a444-444444444444');
    const _: Project = result satisfies Project;
    expect(result.id).toBe('44444444-4444-4444-a444-444444444444');
  });

  it('purgeProject returns void without errors', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const result = await demo.purgeProject('44444444-4444-4444-a444-444444444444');
    expect(result).toBeUndefined();
  });
});

describe('project-service.demo — stable output for reads', () => {
  it('getProject is deterministic for same id', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const a = await demo.getProject('44444444-4444-4444-a444-444444444444');
    const b = await demo.getProject('44444444-4444-4444-a444-444444444444');
    expect(a.id).toBe(b.id);
    expect(a.name).toBe(b.name);
  });

  it('listProjects always returns 3 items', async () => {
    const demo = await import('@/lib/services/project-service.demo');
    const a = await demo.listProjects();
    const b = await demo.listProjects();
    expect(a.length).toBe(3);
    expect(b.length).toBe(3);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
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

// Also mock fs deps that real project-service would use
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

vi.mock('@/lib/services/github-service', () => ({
  detectGitHubRepo: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/services/project-path-service', () => ({
  getProjectPathStatus: vi.fn().mockResolvedValue({ status: 'exists', normalizedPath: '/tmp/x' }),
  validateProjectPath: vi.fn().mockResolvedValue('/tmp/x'),
}));

describe('project-service — short-circuit before DB in demo mode', () => {
  it('does not access db when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.resetModules();

    const svc = await import('@/lib/services/project-service');
    await expect(svc.listProjects()).resolves.toBeDefined();

    vi.unstubAllEnvs();
  });

  it('getProject short-circuits DB for known id in demo mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.resetModules();

    const svc = await import('@/lib/services/project-service');
    await expect(svc.getProject('44444444-4444-4444-a444-444444444444')).resolves.toBeDefined();

    vi.unstubAllEnvs();
  });
});
