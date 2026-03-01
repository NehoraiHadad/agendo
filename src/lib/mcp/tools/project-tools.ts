/**
 * Project tools: list_projects, get_project
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, wrapToolCall } from './shared.js';

// ---------------------------------------------------------------------------
// Handlers (exported for testing)
// ---------------------------------------------------------------------------

export async function handleListProjects(args: { isActive?: boolean }): Promise<unknown> {
  const params = new URLSearchParams();
  if (args.isActive === false) params.set('isActive', 'false');
  else if (args.isActive === undefined) params.set('isActive', 'all');
  // default (isActive === true): omit param — API returns active projects
  const qs = params.toString();
  return apiCall(`/api/projects${qs ? `?${qs}` : ''}`);
}

export async function handleGetProject(args: { projectId: string }): Promise<unknown> {
  return apiCall(`/api/projects/${args.projectId}`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProjectTools(server: McpServer): void {
  server.tool(
    'list_projects',
    'List all projects. By default returns only active projects.',
    {
      isActive: z
        .boolean()
        .optional()
        .describe(
          'Filter by active status. Omit for active only, false for archived, undefined for all.',
        ),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleListProjects(args)),
  );

  server.tool(
    'get_project',
    'Get the full details of a project by its UUID',
    {
      projectId: z.string().describe('UUID of the project to retrieve'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleGetProject(args)),
  );
}
