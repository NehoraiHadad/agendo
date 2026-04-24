/**
 * Demo-mode shadow for workspace-service.
 *
 * Exports fixture data and re-implements every public function from
 * workspace-service.ts without touching the database. Mutations are no-ops
 * that return believable stubs.
 */

import { NotFoundError } from '@/lib/errors';
import type { AgentWorkspace } from '@/lib/types';
import type { CreateWorkspaceInput, UpdateWorkspacePatch } from '@/lib/services/workspace-service';

// ---------------------------------------------------------------------------
// Canonical demo UUIDs (hardcoded to avoid cross-agent import coupling)
// ---------------------------------------------------------------------------

export const DEMO_WORKSPACE_ID = 'bbbbbbbb-bbbb-4001-b001-bbbbbbbbbbbb';
const AGENDO_PROJECT_ID = '44444444-4444-4444-a444-444444444444';

// Session IDs that match sibling agent fixtures
const CLAUDE_SESSION_ID = '77777777-7777-4777-a777-777777777777';
const CODEX_SESSION_ID = '88888888-8888-4888-a888-888888888888';
const GEMINI_SESSION_ID = '99999999-9999-4999-a999-999999999999';

// ---------------------------------------------------------------------------
// Fixed timestamps — deterministic across renders
// ---------------------------------------------------------------------------

const T_7D_AGO = new Date('2026-04-16T10:00:00.000Z');
const T_NOW = new Date('2026-04-23T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Fixtures — must satisfy typeof agentWorkspaces.$inferSelect (AgentWorkspace)
// ---------------------------------------------------------------------------

export const DEMO_WORKSPACE: AgentWorkspace = {
  id: DEMO_WORKSPACE_ID,
  name: 'Demo Workspace',
  projectId: AGENDO_PROJECT_ID,
  layout: {
    panels: [
      {
        sessionId: CLAUDE_SESSION_ID,
        x: 0,
        y: 0,
        w: 2,
        h: 4,
      },
      {
        sessionId: CODEX_SESSION_ID,
        x: 2,
        y: 0,
        w: 2,
        h: 4,
      },
      {
        sessionId: GEMINI_SESSION_ID,
        x: 4,
        y: 0,
        w: 2,
        h: 4,
      },
    ],
    gridCols: 6,
  },
  isActive: true,
  createdAt: T_7D_AGO,
  updatedAt: T_NOW,
};

export const ALL_DEMO_WORKSPACES: AgentWorkspace[] = [DEMO_WORKSPACE];

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function listWorkspaces(filters?: { projectId?: string }): Promise<AgentWorkspace[]> {
  if (filters?.projectId !== undefined) {
    return ALL_DEMO_WORKSPACES.filter((w) => w.projectId === filters.projectId);
  }
  return ALL_DEMO_WORKSPACES;
}

export async function getWorkspace(id: string): Promise<AgentWorkspace> {
  const workspace = ALL_DEMO_WORKSPACES.find((w) => w.id === id);
  if (!workspace) throw new NotFoundError('AgentWorkspace', id);
  return workspace;
}

// ---------------------------------------------------------------------------
// Mutation stubs — no side effects
// ---------------------------------------------------------------------------

/** Returns a stub workspace without touching DB. */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<AgentWorkspace> {
  const now = new Date('2026-04-23T10:00:00.000Z');
  return {
    id: 'demo-stub-workspace-' + Math.random().toString(36).slice(2, 9),
    name: input.name,
    projectId: input.projectId ?? null,
    layout: input.layout ?? { panels: [], gridCols: 2 },
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

/** Returns a stub updated workspace without DB. */
export async function updateWorkspace(
  id: string,
  patch: UpdateWorkspacePatch,
): Promise<AgentWorkspace> {
  const existing = ALL_DEMO_WORKSPACES.find((w) => w.id === id);
  if (!existing) throw new NotFoundError('AgentWorkspace', id);
  return {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.layout !== undefined ? { layout: patch.layout } : {}),
    ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    id,
    updatedAt: new Date('2026-04-23T10:00:00.000Z'),
  };
}

/** No-op delete in demo mode. */
export async function deleteWorkspace(_id: string): Promise<void> {
  // No side effects
}
