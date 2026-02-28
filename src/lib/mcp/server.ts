/**
 * agenDo MCP Server — standalone Node.js process (stdio transport).
 * All logging goes to stderr; stdout is reserved for JSON-RPC.
 *
 * IMPORTANT: No `@/` path aliases — this file is bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const AGENDO_URL = process.env.AGENDO_URL ?? 'http://localhost:4100';

function log(msg: string): void {
  process.stderr.write(`[agendo-mcp] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApiCallOptions {
  method?: string;
  body?: unknown;
}

export async function apiCall(path: string, options: ApiCallOptions = {}): Promise<unknown> {
  const url = `${AGENDO_URL}${path}`;
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

  const keyFindings: Record<string, string[]> = {
    filesExplored: args.filesExplored ?? [],
    findings: args.findings ?? [],
    hypotheses: args.hypotheses ?? [],
    nextSteps: args.nextSteps ?? [],
  };
  body.keyFindings = keyFindings;

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

export async function handleListProjects(args: { isActive?: boolean }): Promise<unknown> {
  const params = new URLSearchParams();
  if (args.isActive === false) params.set('isActive', 'false');
  else if (args.isActive === undefined) params.set('isActive', 'all');
  // default: isActive=true (omit param)
  const qs = params.toString();
  return apiCall(`/api/projects${qs ? `?${qs}` : ''}`);
}

export async function handleGetProject(args: { projectId: string }): Promise<unknown> {
  return apiCall(`/api/projects/${args.projectId}`);
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: 'agendo',
    version: '1.0.0',
  });

  // -- create_task --
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

  // -- get_my_task --
  server.tool(
    'get_my_task',
    'Get the full details of the task assigned to this session, including title, description, status, subtasks, and progress notes',
    {}, // no args - reads AGENDO_TASK_ID from env
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async () => {
      try {
        const result = await handleGetMyTask();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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

  // -- get_task --
  server.tool(
    'get_task',
    'Get the full details of any task by its ID',
    {
      taskId: z.string().describe('UUID of the task to retrieve'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (args) => {
      try {
        const result = await handleGetTask(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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

  // -- add_progress_note --
  server.tool(
    'add_progress_note',
    'Add a progress note to the current task. Use this to report milestones, blockers, or intermediate results.',
    {
      note: z.string().describe('The progress note to add'),
      taskId: z.string().optional().describe('Task ID (defaults to the session task)'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    async (args) => {
      try {
        const result = await handleAddProgressNote(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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

  // -- start_agent_session --
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
    {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    async (args) => {
      try {
        const result = await handleStartAgentSession(args);
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

  // -- save_snapshot --
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
    async (args) => {
      try {
        const result = await handleSaveSnapshot(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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

  // -- update_snapshot --
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
    async (args) => {
      try {
        const result = await handleUpdateSnapshot(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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

  // -- list_projects --
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
    async (args) => {
      try {
        const result = await handleListProjects(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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

  // -- get_project --
  server.tool(
    'get_project',
    'Get the full details of a project by its UUID',
    {
      projectId: z.string().describe('UUID of the project to retrieve'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    async (args) => {
      try {
        const result = await handleGetProject(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
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
  log(`Starting MCP server (API: ${AGENDO_URL})`);

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('MCP server connected via stdio');
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
