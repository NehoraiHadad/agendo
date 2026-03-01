/**
 * Progress tools: add_progress_note
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, wrapToolCall } from './shared.js';

// ---------------------------------------------------------------------------
// Handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleAddProgressNote(args: {
  note: string;
  taskId?: string;
}): Promise<unknown> {
  const taskId = args.taskId ?? process.env.AGENDO_TASK_ID;
  if (!taskId) {
    throw new Error('No taskId provided and AGENDO_TASK_ID not set');
  }
  return apiCall(`/api/tasks/${taskId}/events`, {
    method: 'POST',
    body: { eventType: 'agent_note', payload: { note: args.note } },
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProgressTools(server: McpServer): void {
  server.tool(
    'add_progress_note',
    'Add a progress note to the current task. Use this to report milestones, blockers, or intermediate results.',
    {
      note: z.string().describe('The progress note to add'),
      taskId: z.string().optional().describe('Task ID (defaults to the session task)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (args) => wrapToolCall(() => handleAddProgressNote(args)),
  );
}
