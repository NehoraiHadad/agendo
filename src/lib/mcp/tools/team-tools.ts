/**
 * Team tools: create_team, send_team_message, get_team_status
 *
 * Higher-level orchestration tools that compose existing primitives
 * (create_subtask + start_agent_session + message API) into team operations.
 *
 * IMPORTANT: No `@/` path aliases — bundled with esbuild.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { apiCall, resolveAgentSlug, wrapToolCall, AGENT_NOTE } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamMemberInput {
  agent: string;
  role: string;
  prompt: string;
  permissionMode?: string;
  model?: string;
}

interface TeamMemberResult {
  agent: string;
  subtaskId: string;
  sessionId: string;
}

interface SubtaskWithAssignee {
  id: string;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assignee: { slug: string } | null;
}

interface TaskEvent {
  eventType: string;
  payload: { note?: string };
}

interface SessionInfo {
  id: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Handlers (exported for testing)
// ---------------------------------------------------------------------------

export async function handleCreateTeam(args: {
  taskId: string;
  members: TeamMemberInput[];
}): Promise<{ teamId: string; members: TeamMemberResult[] }> {
  if (args.members.length === 0) {
    throw new Error('At least one team member is required');
  }

  const results: TeamMemberResult[] = [];
  const projectId = process.env.AGENDO_PROJECT_ID;

  for (const member of args.members) {
    const agentId = await resolveAgentSlug(member.agent);

    // 1. Create subtask under parent task
    const subtaskBody: Record<string, unknown> = {
      title: member.role,
      parentTaskId: args.taskId,
      assigneeAgentId: agentId,
    };
    if (projectId) subtaskBody.projectId = projectId;

    const subtask = (await apiCall('/api/tasks', {
      method: 'POST',
      body: subtaskBody,
    })) as { id: string };

    // 2. Spawn agent session on the subtask
    const sessionBody: Record<string, unknown> = {
      taskId: subtask.id,
      agentId,
      initialPrompt: member.prompt,
      permissionMode: member.permissionMode ?? 'bypassPermissions',
    };
    if (member.model) sessionBody.model = member.model;

    const session = (await apiCall('/api/sessions', {
      method: 'POST',
      body: sessionBody,
    })) as { id: string };

    results.push({
      agent: member.agent,
      subtaskId: subtask.id,
      sessionId: session.id,
    });
  }

  return { teamId: args.taskId, members: results };
}

export async function handleSendTeamMessage(args: {
  sessionId: string;
  message: string;
}): Promise<unknown> {
  return apiCall(`/api/sessions/${args.sessionId}/message`, {
    method: 'POST',
    body: { message: args.message },
  });
}

export async function handleGetTeamStatus(args: { taskId: string }): Promise<{
  taskId: string;
  title: string;
  status: string;
  members: Array<{
    subtaskId: string;
    title: string;
    status: string;
    assignee: string | null;
    latestNote: string | null;
    sessionId: string | null;
    sessionStatus: string | null;
  }>;
}> {
  // Fetch parent task and subtasks in parallel
  const [parentTask, subtasks] = await Promise.all([
    apiCall(`/api/tasks/${args.taskId}`) as Promise<{
      id: string;
      title: string;
      status: string;
    }>,
    apiCall(`/api/tasks/${args.taskId}/subtasks`) as Promise<SubtaskWithAssignee[]>,
  ]);

  // For each subtask, fetch latest progress note and active session
  const members = await Promise.all(
    subtasks.map(async (subtask) => {
      const [events, sessions] = await Promise.all([
        apiCall(`/api/tasks/${subtask.id}/events`) as Promise<TaskEvent[]>,
        apiCall(`/api/sessions?taskId=${subtask.id}`) as Promise<SessionInfo[]>,
      ]);

      const progressNotes = events.filter((e) => e.eventType === AGENT_NOTE);
      const latestNote =
        progressNotes.length > 0
          ? (progressNotes[progressNotes.length - 1].payload.note ?? null)
          : null;

      // Find the most recent session (first in the list, assuming sorted by creation)
      const activeSession = sessions.length > 0 ? sessions[0] : null;

      return {
        subtaskId: subtask.id,
        title: subtask.title,
        status: subtask.status,
        assignee: subtask.assignee?.slug ?? null,
        latestNote,
        sessionId: activeSession?.id ?? null,
        sessionStatus: activeSession?.status ?? null,
      };
    }),
  );

  return {
    taskId: parentTask.id,
    title: parentTask.title,
    status: parentTask.status,
    members,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const memberSchema = z.object({
  agent: z.string().describe('Agent slug (e.g. claude-code-1, codex-cli-1, gemini-cli-1)'),
  role: z.string().describe('Role / subtask title for this team member'),
  prompt: z.string().describe('Initial prompt / instructions for this agent'),
  permissionMode: z
    .enum(['default', 'bypassPermissions', 'acceptEdits'])
    .optional()
    .describe('Permission mode (default: bypassPermissions)'),
  model: z.string().optional().describe('Override AI model for this member'),
});

export function registerTeamTools(server: McpServer): void {
  server.tool(
    'create_team',
    'Create a team of agents working on subtasks under a parent task. Batch-creates subtasks and spawns agent sessions for each member. Returns sessionIds for monitoring.',
    {
      taskId: z.string().describe('UUID of the parent task (becomes the team container)'),
      members: z
        .array(memberSchema)
        .min(1)
        .describe('Team members to create — each gets a subtask + session'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (args) => wrapToolCall(() => handleCreateTeam(args)),
  );

  server.tool(
    'send_team_message',
    "Send a message to a team member's session. Use to give course corrections, ask for status, or coordinate work.",
    {
      sessionId: z.string().describe('UUID of the target session'),
      message: z.string().describe('Message text to send'),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    (args) => wrapToolCall(() => handleSendTeamMessage(args)),
  );

  server.tool(
    'get_team_status',
    "Get the status of all team members under a parent task. Shows each subtask's status, latest progress note, and session state.",
    {
      taskId: z.string().describe('UUID of the parent task (team container)'),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    (args) => wrapToolCall(() => handleGetTeamStatus(args)),
  );
}
