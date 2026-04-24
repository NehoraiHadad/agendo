/**
 * Demo-mode shadow for snapshot-service.ts.
 *
 * All exported functions mirror the real service's signatures exactly, but
 * operate entirely on in-memory fixtures — no database access.
 *
 * Mutations return plausible stubs. `resumeFromSnapshot` returns a canonical
 * demo session ID rather than creating a real session.
 *
 * Imported only via dynamic `await import('./snapshot-service.demo')` in demo
 * mode so it is tree-shaken from production bundles.
 */

import { randomUUID } from 'crypto';
import { NotFoundError } from '@/lib/errors';
import { CLAUDE_SESSION_ID } from '@/lib/services/session-service.demo';
import type { ContextSnapshot } from '@/lib/types';
import type { CreateSnapshotInput, ResumeFromSnapshotOpts } from '@/lib/services/snapshot-service';

// ============================================================================
// Canonical shared IDs (must match across all Phase-1 agents)
// ============================================================================

const PROJECT_AGENDO = '44444444-4444-4444-a444-444444444444';

// Fixed reference point for deterministic timestamps
const NOW = new Date('2026-04-23T10:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// ============================================================================
// Fixture data — 2 snapshots for the Claude session in the agendo project
// ============================================================================

export const DEMO_SNAPSHOTS: readonly ContextSnapshot[] = [
  {
    id: 'cccccccc-cccc-4001-c001-cccccccccccc',
    projectId: PROJECT_AGENDO,
    sessionId: CLAUDE_SESSION_ID,
    name: 'Initial DB schema investigation',
    summary:
      'Explored the Drizzle schema in src/lib/db/schema.ts. Identified the tasks, sessions, and agents tables as the core models. The pg-boss queue config is in ecosystem.config.js and references the same DATABASE_URL. Schema changes require pnpm db:generate followed by pnpm db:migrate for upgrades.',
    keyFindings: {
      filesExplored: [
        'src/lib/db/schema.ts',
        'src/lib/services/task-service.ts',
        'ecosystem.config.js',
      ],
      findings: [
        'tasks table uses sparse sort_order gaps (1000-increments) for drag-and-drop reordering',
        'sessions are linked to tasks via task_id FK with cascade delete',
        'pg-boss queue names match the job type strings in worker handlers',
      ],
      hypotheses: [
        'Bottleneck for large boards may be the listTasksBoardItems join on subtask counts',
      ],
      nextSteps: [
        'Add index on tasks(project_id, status) for filtered board queries',
        'Profile listTasksBoardItems with 500+ tasks',
      ],
    },
    metadata: {},
    createdAt: hoursAgo(36),
  },
  {
    id: 'cccccccc-cccc-4002-c002-cccccccccccc',
    projectId: PROJECT_AGENDO,
    sessionId: CLAUDE_SESSION_ID,
    name: 'MCP tool handler implementation progress',
    summary:
      'Implemented create_task and update_task MCP tools via @modelcontextprotocol/sdk stdio transport. The handler lives in src/lib/mcp/tools/. Routing from the MCP server to API endpoints is wired but the Cedar policy scope check for the agent role is still pending. Tool schemas validated with Zod; error mapping to MCP error codes is complete.',
    keyFindings: {
      filesExplored: [
        'src/lib/mcp/tools/artifact-tools.ts',
        'src/lib/mcp/tools/snapshot-tools.ts',
        'src/lib/worker/adapters/claude-sdk-adapter.ts',
      ],
      findings: [
        'MCP server is bundled separately with esbuild (pnpm build:mcp) — no @/ aliases allowed',
        'Tool calls reach the Next.js API over HTTP using the same JWT_SECRET bearer token',
        'Permission mode bypassPermissions auto-approves all tool calls including MCP',
      ],
      hypotheses: [],
      nextSteps: [
        'Wire Cedar policy check for agent role before merging',
        'Add integration test for create_task → listTasksByStatus round-trip',
      ],
    },
    metadata: {},
    createdAt: hoursAgo(6),
  },
] satisfies readonly ContextSnapshot[];

// ============================================================================
// Internal helpers
// ============================================================================

function findSnapshotOrThrow(id: string): ContextSnapshot {
  const snapshot = DEMO_SNAPSHOTS.find((s) => s.id === id);
  if (!snapshot) {
    throw new NotFoundError(`ContextSnapshot ${id} not found`);
  }
  return snapshot;
}

// ============================================================================
// Shadow exports — must match snapshot-service.ts signatures exactly
// ============================================================================

export async function createSnapshot(input: CreateSnapshotInput): Promise<ContextSnapshot> {
  const now = new Date();
  return {
    id: randomUUID(),
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    name: input.name,
    summary: input.summary,
    keyFindings: input.keyFindings ?? {
      filesExplored: [],
      findings: [],
      hypotheses: [],
      nextSteps: [],
    },
    metadata: {},
    createdAt: now,
  };
}

export async function getSnapshot(id: string): Promise<ContextSnapshot> {
  return findSnapshotOrThrow(id);
}

export async function listSnapshots(filters?: {
  projectId?: string;
  limit?: number;
}): Promise<ContextSnapshot[]> {
  const limit = filters?.limit ?? 50;

  let results = [...DEMO_SNAPSHOTS];

  if (filters?.projectId) {
    results = results.filter((s) => s.projectId === filters.projectId);
  }

  // Newest first — matches production orderBy(desc(contextSnapshots.createdAt))
  results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  return results.slice(0, limit);
}

export async function updateSnapshot(
  id: string,
  patch: { name?: string; summary?: string; keyFindings?: ContextSnapshot['keyFindings'] },
): Promise<ContextSnapshot> {
  const existing = findSnapshotOrThrow(id);
  return {
    ...existing,
    ...(patch.name !== undefined && { name: patch.name }),
    ...(patch.summary !== undefined && { summary: patch.summary }),
    ...(patch.keyFindings !== undefined && { keyFindings: patch.keyFindings }),
  };
}

export async function deleteSnapshot(_id: string): Promise<void> {
  // No-op: demo mode does not persist deletions.
}

/**
 * Resume from snapshot by returning a canonical demo session ID — no side effects.
 */
export async function resumeFromSnapshot(
  _snapshotId: string,
  _opts: ResumeFromSnapshotOpts,
): Promise<{ sessionId: string }> {
  return { sessionId: CLAUDE_SESSION_ID };
}
