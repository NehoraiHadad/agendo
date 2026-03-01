/**
 * Task tools: create_task, update_task, list_tasks, get_my_task, get_task
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, resolveAgentSlug, parsePriority, wrapToolCall } from './shared.js';

// ---------------------------------------------------------------------------
// Handlers (exported for testing)
// ---------------------------------------------------------------------------

export async function handleCreateTask(args: {
  title: string;
  description?: string;
  priority?: string | number;
  status?: string;
  assignee?: string;
  dueAt?: string;
  projectId?: string;
}): Promise<unknown> {
  const body: Record<string, unknown> = { title: args.title };
  if (args.description) body.description = args.description;
  if (args.priority !== undefined) body.priority = parsePriority(args.priority);
  if (args.status) body.status = args.status;
  if (args.dueAt) body.dueAt = args.dueAt;

  // Explicit projectId takes precedence over env var
  const projectId = args.projectId ?? process.env.AGENDO_PROJECT_ID;
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

export async function handleUpdateTask(args: {
  taskId: string;
  title?: string;
  description?: string;
  priority?: string | number;
  status?: string;
  assignee?: string;
  dueAt?: string;
}): Promise<unknown> {
  const body: Record<string, unknown> = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.description !== undefined) body.description = args.description;
  if (args.priority !== undefined) body.priority = parsePriority(args.priority);
  if (args.status !== undefined) body.status = args.status;
  if (args.dueAt !== undefined) body.dueAt = args.dueAt;

  if (args.assignee !== undefined) {
    body.assigneeAgentId = await resolveAgentSlug(args.assignee);
  }

  return apiCall(`/api/tasks/${args.taskId}`, { method: 'PATCH', body });
}

export async function handleListTasks(args: {
  status?: string;
  assignee?: string;
  limit?: number;
}): Promise<unknown> {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  params.set('limit', String(args.limit ?? 100));

  const qs = params.toString();
  const result = (await apiCall(`/api/tasks?${qs}`)) as Array<{
    assigneeAgentId?: string | null;
  }>;

  // Client-side filter by assignee if provided
  if (args.assignee && Array.isArray(result)) {
    const agentId = await resolveAgentSlug(args.assignee);
    return result.filter((t) => t.assigneeAgentId === agentId);
  }

  return result;
}

export async function handleGetMyTask(): Promise<unknown> {
  const taskId = process.env.AGENDO_TASK_ID;
  if (!taskId) {
    return {
      message:
        'This is a planning conversation with no assigned task. Use create_task to create tasks.',
    };
  }
  return apiCall(`/api/tasks/${taskId}`);
}

export async function handleGetTask(args: { taskId: string }): Promise<unknown> {
  return apiCall(`/api/tasks/${args.taskId}`);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTaskTools(server: McpServer): void {
  server.tool(
    'create_task',
    'Create a new task on the agenDo board',
    {
      title: z.string().describe('Task title'),
      description: z.string().optional().describe('Task description'),
      priority: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Priority: 1-5 or lowest/low/medium/high/highest'),
      status: z.string().optional().describe('Task status (e.g., todo, in_progress, review, done)'),
      assignee: z.string().optional().describe('Agent slug to assign the task to'),
      dueAt: z.string().optional().describe('Due date in ISO 8601 format'),
      projectId: z
        .string()
        .optional()
        .describe('Project UUID to create the task in (overrides session default)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (args) => wrapToolCall(() => handleCreateTask(args)),
  );

  server.tool(
    'update_task',
    'Update an existing task',
    {
      taskId: z.string().describe('UUID of the task to update'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      priority: z
        .union([z.string(), z.number()])
        .optional()
        .describe('New priority: 1-5 or lowest/low/medium/high/highest'),
      status: z.string().optional().describe('New status'),
      assignee: z.string().optional().describe('Agent slug to reassign to'),
      dueAt: z.string().optional().describe('New due date in ISO 8601 format'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleUpdateTask(args)),
  );

  server.tool(
    'list_tasks',
    'List tasks, optionally filtered by status and assignee',
    {
      status: z.string().optional().describe('Filter by task status'),
      assignee: z.string().optional().describe('Filter by agent slug'),
      limit: z.number().optional().describe('Maximum number of tasks to return (default 100)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleListTasks(args)),
  );

  server.tool(
    'get_my_task',
    'Get the full details of the task assigned to this session, including title, description, status, subtasks, and progress notes',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    () => wrapToolCall(() => handleGetMyTask()),
  );

  server.tool(
    'get_task',
    'Get the full details of any task by its ID',
    {
      taskId: z.string().describe('UUID of the task to retrieve'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleGetTask(args)),
  );
}
