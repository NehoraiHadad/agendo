/**
 * Subtask tools: create_subtask
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, resolveAgentSlug, parsePriority, wrapToolCall } from './shared.js';

// ---------------------------------------------------------------------------
// Handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleCreateSubtask(args: {
  parentTaskId: string;
  title: string;
  description?: string;
  priority?: string | number;
  assignee?: string;
}): Promise<unknown> {
  const body: Record<string, unknown> = {
    title: args.title,
    parentTaskId: args.parentTaskId,
  };
  if (args.description) body.description = args.description;
  if (args.priority !== undefined) body.priority = parsePriority(args.priority);

  // Implicit context from session env vars
  const projectId = process.env.AGENDO_PROJECT_ID;
  if (projectId) body.projectId = projectId;

  if (args.assignee) {
    body.assigneeAgentId = await resolveAgentSlug(args.assignee);
  } else {
    // Auto-assign to the session agent if no explicit assignee
    const agentId = process.env.AGENDO_AGENT_ID;
    if (agentId) body.assigneeAgentId = agentId;
  }

  return apiCall('/api/tasks', { method: 'POST', body });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSubtaskTools(server: McpServer): void {
  server.tool(
    'create_subtask',
    'Create a subtask under an existing parent task',
    {
      parentTaskId: z.string().describe('UUID of the parent task'),
      title: z.string().describe('Subtask title'),
      description: z.string().optional().describe('Subtask description'),
      priority: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Priority: 1-5 or lowest/low/medium/high/highest'),
      assignee: z.string().optional().describe('Agent slug to assign the subtask to'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (args) => wrapToolCall(() => handleCreateSubtask(args)),
  );
}
