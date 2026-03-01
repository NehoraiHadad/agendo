/**
 * Snapshot tools: save_snapshot, update_snapshot
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, wrapToolCall } from './shared.js';

// ---------------------------------------------------------------------------
// Handlers (exported for testing)
// ---------------------------------------------------------------------------

export async function handleSaveSnapshot(args: {
  name: string;
  summary: string;
  filesExplored?: string[];
  findings?: string[];
  hypotheses?: string[];
  nextSteps?: string[];
}): Promise<unknown> {
  const projectId = process.env.AGENDO_PROJECT_ID;
  if (!projectId) {
    throw new Error('AGENDO_PROJECT_ID not set — snapshots require a project context');
  }
  const sessionId = process.env.AGENDO_SESSION_ID;

  const body: Record<string, unknown> = {
    projectId,
    name: args.name,
    summary: args.summary,
  };
  if (sessionId) body.sessionId = sessionId;

  body.keyFindings = {
    filesExplored: args.filesExplored ?? [],
    findings: args.findings ?? [],
    hypotheses: args.hypotheses ?? [],
    nextSteps: args.nextSteps ?? [],
  };

  return apiCall('/api/snapshots', { method: 'POST', body });
}

export async function handleUpdateSnapshot(args: {
  snapshotId: string;
  name?: string;
  summary?: string;
  filesExplored?: string[];
  findings?: string[];
  hypotheses?: string[];
  nextSteps?: string[];
}): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (args.name !== undefined) body.name = args.name;
  if (args.summary !== undefined) body.summary = args.summary;

  // Only send keyFindings if any array field was provided
  if (
    args.filesExplored !== undefined ||
    args.findings !== undefined ||
    args.hypotheses !== undefined ||
    args.nextSteps !== undefined
  ) {
    // Fetch current snapshot to merge with existing findings
    const current = (await apiCall(`/api/snapshots/${args.snapshotId}`)) as {
      keyFindings?: {
        filesExplored?: string[];
        findings?: string[];
        hypotheses?: string[];
        nextSteps?: string[];
      };
    };
    const existing = current.keyFindings ?? {};
    body.keyFindings = {
      filesExplored: args.filesExplored ?? existing.filesExplored ?? [],
      findings: args.findings ?? existing.findings ?? [],
      hypotheses: args.hypotheses ?? existing.hypotheses ?? [],
      nextSteps: args.nextSteps ?? existing.nextSteps ?? [],
    };
  }

  return apiCall(`/api/snapshots/${args.snapshotId}`, { method: 'PATCH', body });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSnapshotTools(server: McpServer): void {
  server.tool(
    'save_snapshot',
    'Save a snapshot of your current investigation context. Use this to preserve your findings, hypotheses, and next steps so the investigation can be resumed later by you or another agent.',
    {
      name: z
        .string()
        .describe(
          'Short descriptive name for the snapshot (e.g. "Auth token refresh bug investigation")',
        ),
      summary: z.string().describe('Markdown summary of what you investigated and discovered'),
      filesExplored: z
        .array(z.string())
        .optional()
        .describe('List of file paths you examined during this investigation'),
      findings: z
        .array(z.string())
        .optional()
        .describe('Key findings and observations from the investigation'),
      hypotheses: z
        .array(z.string())
        .optional()
        .describe('Current hypotheses about the issue or feature'),
      nextSteps: z
        .array(z.string())
        .optional()
        .describe('Recommended next steps for whoever resumes this investigation'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (args) => wrapToolCall(() => handleSaveSnapshot(args)),
  );

  server.tool(
    'update_snapshot',
    'Update an existing context snapshot. Use this to refine findings, add new discoveries, or update next steps as your investigation progresses.',
    {
      snapshotId: z.string().describe('UUID of the snapshot to update'),
      name: z.string().optional().describe('Updated name for the snapshot'),
      summary: z.string().optional().describe('Updated markdown summary'),
      filesExplored: z
        .array(z.string())
        .optional()
        .describe('Updated list of explored file paths (replaces existing)'),
      findings: z.array(z.string()).optional().describe('Updated findings (replaces existing)'),
      hypotheses: z.array(z.string()).optional().describe('Updated hypotheses (replaces existing)'),
      nextSteps: z.array(z.string()).optional().describe('Updated next steps (replaces existing)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleUpdateSnapshot(args)),
  );
}
