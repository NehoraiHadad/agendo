/**
 * Demo mode tests for workspace-service.
 *
 * Tests the demo shadow module directly and verifies the isDemoMode() branch
 * in the real service fires before any DB access.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentWorkspace } from '@/lib/types';

// ---- Direct demo module tests -----------------------------------------------

describe('workspace-service.demo — shape parity', () => {
  it('listWorkspaces returns 1 demo workspace', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const result = await demo.listWorkspaces();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('workspace fixture satisfies AgentWorkspace type', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const result = await demo.listWorkspaces();
    const _: AgentWorkspace[] = result satisfies AgentWorkspace[];
  });

  it('workspace has canonical id bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const [ws] = await demo.listWorkspaces();
    expect(ws.id).toBe('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb');
    expect(ws.name).toBe('Demo Workspace');
  });

  it('workspace layout has 3 panels', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const [ws] = await demo.listWorkspaces();
    expect(ws.layout.panels).toHaveLength(3);
  });

  it('workspace panels reference the 3 canonical session IDs', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const [ws] = await demo.listWorkspaces();
    const sessionIds = ws.layout.panels.map((p) => p.sessionId);
    expect(sessionIds).toContain('77777777-7777-4777-a777-777777777777');
    expect(sessionIds).toContain('88888888-8888-4888-a888-888888888888');
    expect(sessionIds).toContain('99999999-9999-4999-a999-999999999999');
  });

  it('all workspace fixture fields are valid types', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const [ws] = await demo.listWorkspaces();
    expect(typeof ws.id).toBe('string');
    expect(typeof ws.name).toBe('string');
    expect(typeof ws.isActive).toBe('boolean');
    expect(ws.createdAt).toBeInstanceOf(Date);
    expect(ws.updatedAt).toBeInstanceOf(Date);
    expect(typeof ws.layout).toBe('object');
    expect(Array.isArray(ws.layout.panels)).toBe(true);
  });

  it('getWorkspace returns the workspace for canonical id', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const result = await demo.getWorkspace('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb');
    const _: AgentWorkspace = result satisfies AgentWorkspace;
    expect(result.id).toBe('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb');
  });

  it('getWorkspace throws NotFoundError for unknown id', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    await expect(demo.getWorkspace('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('listWorkspaces filters by projectId (agendo project)', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const result = await demo.listWorkspaces({
      projectId: '44444444-4444-4444-a444-444444444444',
    });
    expect(result).toHaveLength(1);
  });

  it('listWorkspaces returns empty for unknown projectId filter', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const result = await demo.listWorkspaces({
      projectId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result).toHaveLength(0);
  });
});

describe('workspace-service.demo — mutation stubs', () => {
  it('createWorkspace returns AgentWorkspace-shaped stub without persisting', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const result = await demo.createWorkspace({ name: 'New Workspace' });
    const _: AgentWorkspace = result satisfies AgentWorkspace;
    expect(result.name).toBe('New Workspace');
    expect(typeof result.id).toBe('string');
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('updateWorkspace returns merged AgentWorkspace shape', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const result = await demo.updateWorkspace('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb', {
      name: 'Updated Name',
    });
    const _: AgentWorkspace = result satisfies AgentWorkspace;
    expect(result.id).toBe('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb');
    expect(result.name).toBe('Updated Name');
  });

  it('updateWorkspace throws for unknown id', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    await expect(
      demo.updateWorkspace('00000000-0000-0000-0000-000000000000', { name: 'x' }),
    ).rejects.toThrow();
  });

  it('deleteWorkspace returns void without errors', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const result = await demo.deleteWorkspace('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb');
    expect(result).toBeUndefined();
  });
});

describe('workspace-service.demo — stable output for reads', () => {
  it('listWorkspaces is deterministic across calls', async () => {
    const demo = await import('@/lib/services/workspace-service.demo');
    const a = await demo.listWorkspaces();
    const b = await demo.listWorkspaces();
    expect(a.map((w) => w.id)).toEqual(b.map((w) => w.id));
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

describe('workspace-service — short-circuit before DB in demo mode', () => {
  it('does not access db when NEXT_PUBLIC_DEMO_MODE=true', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.resetModules();

    const svc = await import('@/lib/services/workspace-service');
    await expect(svc.listWorkspaces()).resolves.toBeDefined();

    vi.unstubAllEnvs();
  });

  it('getWorkspace does not access db in demo mode', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', 'true');
    vi.resetModules();

    const svc = await import('@/lib/services/workspace-service');
    await expect(svc.getWorkspace('bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb')).resolves.toBeDefined();

    vi.unstubAllEnvs();
  });
});
