/**
 * Agent Monitor MCP Server — standalone Node.js process (stdio transport).
 * All logging goes to stderr; stdout is reserved for JSON-RPC.
 *
 * IMPORTANT: No `@/` path aliases — this file is bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const AGENT_MONITOR_URL = process.env.AGENT_MONITOR_URL ?? 'http://localhost:4100';

function log(msg: string): void {
  process.stderr.write(`[agent-monitor-mcp] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApiCallOptions {
  method?: string;
  body?: unknown;
}

export async function apiCall(path: string, options: ApiCallOptions = {}): Promise<unknown> {
  const url = `${AGENT_MONITOR_URL}${path}`;
  const { method = 'GET', body } = options;

  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const json = (await res.json()) as {
    data?: unknown;
    error?: { message?: string };
  };

  if (!res.ok) {
    const errMsg = json.error?.message ?? `API error ${res.status}: ${res.statusText}`;
    throw new Error(errMsg);
  }

  return json.data;
}

export async function resolveAgentSlug(slug: string): Promise<string> {
  const data = (await apiCall(`/api/agents?slug=${encodeURIComponent(slug)}`)) as
    | Array<{ id: string }>
    | undefined;

  if (!data || data.length === 0) {
    throw new Error(`Agent not found: ${slug}`);
  }

  return data[0].id;
}

// ---------------------------------------------------------------------------
// Priority parsing
// ---------------------------------------------------------------------------

const PRIORITY_MAP: Record<string, number> = {
  lowest: 1,
  low: 2,
  medium: 3,
  high: 4,
  highest: 5,
  critical: 5,
};

export function parsePriority(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const num = parseInt(value, 10);
  if (!isNaN(num)) return num;
  return PRIORITY_MAP[value.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Tool handlers (exported for testing)
// ---------------------------------------------------------------------------

export async function handleCreateTask(args: {
  title: string;
  description?: string;
  priority?: string | number;
  status?: string;
  assignee?: string;
  dueAt?: string;
}): Promise<unknown> {
  const body: Record<string, unknown> = { title: args.title };
  if (args.description) body.description = args.description;
  if (args.priority !== undefined) body.priority = parsePriority(args.priority);
  if (args.status) body.status = args.status;
  if (args.dueAt) body.dueAt = args.dueAt;

  if (args.assignee) {
    body.assigneeAgentId = await resolveAgentSlug(args.assignee);
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

  if (args.assignee) {
    body.assigneeAgentId = await resolveAgentSlug(args.assignee);
  }

  return apiCall('/api/tasks', { method: 'POST', body });
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
// MCP Server setup
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: 'agent-monitor',
    version: '1.0.0',
  });

  // -- create_task --
  server.tool(
    'create_task',
    'Create a new task on the Agent Monitor board',
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
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async (args) => {
      try {
        const result = await handleCreateTask(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // -- update_task --
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
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    async (args) => {
      try {
        const result = await handleUpdateTask(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // -- list_tasks --
  server.tool(
    'list_tasks',
    'List tasks, optionally filtered by status and assignee',
    {
      status: z.string().optional().describe('Filter by task status'),
      assignee: z.string().optional().describe('Filter by agent slug'),
      limit: z.number().optional().describe('Maximum number of tasks to return (default 100)'),
    },
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    async (args) => {
      try {
        const result = await handleListTasks(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // -- create_subtask --
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
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async (args) => {
      try {
        const result = await handleCreateSubtask(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  // -- assign_task --
  server.tool(
    'assign_task',
    'Assign a task to an agent by slug',
    {
      taskId: z.string().describe('UUID of the task to assign'),
      assignee: z.string().describe('Agent slug to assign the task to'),
    },
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
    async (args) => {
      try {
        const result = await handleAssignTask(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting MCP server (API: ${AGENT_MONITOR_URL})`);

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('MCP server connected via stdio');
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
