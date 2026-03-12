/**
 * Progress tools: add_progress_note
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, wrapToolCall, resolveTaskId, AGENT_NOTE } from './shared.js';

// ---------------------------------------------------------------------------
// Handler (exported for testing)
// ---------------------------------------------------------------------------

export async function handleGetProgressNotes(args: { taskId?: string }): Promise<unknown> {
  const taskId = resolveTaskId(args.taskId);
  const events = (await apiCall(`/api/tasks/${taskId}/events`)) as Array<{ eventType: string }>;
  return events.filter((e) => e.eventType === AGENT_NOTE);
}

export async function handleAddProgressNote(args: {
  note: string;
  taskId?: string;
}): Promise<unknown> {
  const taskId = resolveTaskId(args.taskId);
  return apiCall(`/api/tasks/${taskId}/events`, {
    method: 'POST',
    body: { eventType: AGENT_NOTE, payload: { note: args.note } },
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProgressTools(server: McpServer): void {
  server.tool(
    'get_progress_notes',
    'Get the progress note history for a task. Returns all agent_note events in chronological order.',
    {
      taskId: z.string().optional().describe('Task ID (defaults to the session task)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleGetProgressNotes(args)),
  );

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
