/**
 * Session tools: start_agent_session, assign_task
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, resolveAgentSlug, wrapToolCall } from './shared.js';

// ---------------------------------------------------------------------------
// Handlers (exported for testing)
// ---------------------------------------------------------------------------

export async function handleStartAgentSession(args: {
  taskId: string;
  agent: string;
  initialPrompt?: string;
  permissionMode?: 'default' | 'bypassPermissions' | 'acceptEdits';
  model?: string;
}): Promise<unknown> {
  // 1. Resolve agent slug → UUID
  const agentId = await resolveAgentSlug(args.agent);

  // 2. Find a prompt-mode capability for this agent
  const capabilities = (await apiCall(`/api/agents/${agentId}/capabilities`)) as Array<{
    id: string;
    interactionMode: string;
  }>;
  const promptCap = capabilities.find((c) => c.interactionMode === 'prompt');
  if (!promptCap) {
    throw new Error(`Agent "${args.agent}" has no prompt-mode capability. Cannot start a session.`);
  }

  // 3. Create and enqueue the session (fire-and-forget)
  const session = (await apiCall('/api/sessions', {
    method: 'POST',
    body: {
      taskId: args.taskId,
      agentId,
      capabilityId: promptCap.id,
      initialPrompt: args.initialPrompt,
      permissionMode: args.permissionMode ?? 'bypassPermissions',
      ...(args.model ? { model: args.model } : {}),
    },
  })) as { id: string };

  return { sessionId: session.id, agentId, taskId: args.taskId, agent: args.agent };
}

export async function handleAssignTask(args: {
  taskId: string;
  assignee: string;
}): Promise<unknown> {
  const assigneeAgentId = await resolveAgentSlug(args.assignee);
  return apiCall(`/api/tasks/${args.taskId}`, {
    method: 'PATCH',
    body: { assigneeAgentId },
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSessionTools(server: McpServer): void {
  server.tool(
    'start_agent_session',
    'Start a new agent session for a task. The session runs asynchronously (fire-and-forget). Returns a sessionId you can use to monitor progress.',
    {
      taskId: z.string().describe('UUID of the task the agent should work on'),
      agent: z.string().describe('Agent slug (e.g. claude-code-1, codex-cli-1, gemini-cli-1)'),
      initialPrompt: z
        .string()
        .optional()
        .describe('Initial prompt / instructions to send to the agent'),
      permissionMode: z
        .enum(['default', 'bypassPermissions', 'acceptEdits'])
        .optional()
        .describe(
          'Permission mode for the session. Defaults to bypassPermissions for autonomous operation.',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Override the default AI model (e.g. gemini-2.5-pro, o3). Forwarded as -m flag to the CLI.',
        ),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (args) => wrapToolCall(() => handleStartAgentSession(args)),
  );

  server.tool(
    'assign_task',
    'Assign a task to an agent by slug',
    {
      taskId: z.string().describe('UUID of the task to assign'),
      assignee: z.string().describe('Agent slug to assign the task to'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleAssignTask(args)),
  );
}
