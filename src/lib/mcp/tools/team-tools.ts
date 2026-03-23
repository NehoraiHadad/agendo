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
  role: string;
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
    const leadSessionId = process.env.AGENDO_SESSION_ID;
    const sessionBody: Record<string, unknown> = {
      taskId: subtask.id,
      agentId,
      initialPrompt: member.prompt,
      permissionMode: member.permissionMode ?? 'bypassPermissions',
    };
    if (member.model) sessionBody.model = member.model;
    if (leadSessionId) sessionBody.parentSessionId = leadSessionId;

    const session = (await apiCall('/api/sessions', {
      method: 'POST',
      body: sessionBody,
    })) as { id: string };

    results.push({
      agent: member.agent,
      role: member.role,
      subtaskId: subtask.id,
      sessionId: session.id,
    });
  }

  // 3. Broadcast team context to each worker so they know their teammates
  const leadSessionId = process.env.AGENDO_SESSION_ID;
  if (leadSessionId) {
    await broadcastTeamContext(leadSessionId, results);
  }

  return { teamId: args.taskId, members: results };
}

/**
 * Send a team context message to each worker session so they know:
 * - The team lead's sessionId (for escalations)
 * - Their sibling sessions (for peer coordination)
 * - That send_team_message is available
 *
 * Fire-and-forget: errors are silently ignored to avoid blocking team creation.
 */
async function broadcastTeamContext(
  leadSessionId: string,
  members: TeamMemberResult[],
): Promise<void> {
  const sends = members.map((member) => {
    const message = buildTeamContextMessage(leadSessionId, members, member.sessionId);
    return apiCall(`/api/sessions/${member.sessionId}/message`, {
      method: 'POST',
      body: { message },
    }).catch(() => {
      // Silently ignore — worker may not be ready yet
    });
  });

  await Promise.all(sends);
}

/**
 * Build the team context message that gets sent to a worker.
 * Comprehensive teamwork instructions inspired by Claude's TeamCreate prompt,
 * adapted for Agendo MCP-based teams.
 */
export function buildTeamContextMessage(
  leadSessionId: string,
  members: TeamMemberResult[],
  currentSessionId: string,
): string {
  const currentMember = members.find((m) => m.sessionId === currentSessionId);
  const siblings = members.filter((m) => m.sessionId !== currentSessionId);

  let msg =
    `[Team Context — You Are Part of a Team]\n\n` +
    `You are **${currentMember?.role ?? 'a team member'}** working alongside other AI agents.\n` +
    `Other agents are working in parallel on related subtasks. Coordination is essential.\n\n`;

  // Team roster
  msg +=
    `## Your Team\n\n` +
    `**Team Lead** (orchestrator):\n` +
    `- Session: \`${leadSessionId}\`\n` +
    `- Messages: \`send_team_message({sessionId: "${leadSessionId}", message: "..."})\`\n\n`;

  if (siblings.length > 0) {
    msg += `**Teammates** (working in parallel):\n`;
    for (const sibling of siblings) {
      msg += `- **${sibling.role}** (${sibling.agent}) — session \`${sibling.sessionId}\`\n`;
    }
    msg += `\n`;
  }

  // When to communicate
  msg +=
    `## When to Communicate\n\n` +
    `You MUST send a message to your team in these situations:\n\n` +
    `1. **Blocked**: You need something from another agent's work → message that agent directly\n` +
    `2. **API/interface change**: You changed a function signature, schema, or API that others depend on → notify affected teammates\n` +
    `3. **Completion**: You finished your subtask → tell the team lead so they can track progress\n` +
    `4. **File conflict risk**: You need to modify a file that might be touched by another agent → coordinate first\n` +
    `5. **Discovery**: You found a bug, missing dependency, or design issue that affects the team → share immediately\n` +
    `6. **Handoff ready**: Your output is an input to another agent's work → send them the details\n\n`;

  // How to communicate
  msg +=
    `## How to Communicate\n\n` +
    `Use plain text messages (NOT JSON). Be concise and actionable:\n\n` +
    `\`\`\`\n` +
    `// Good — actionable, includes file paths\n` +
    `send_team_message({sessionId: "...", message: "Finished the API routes. New endpoints:\\n` +
    `- POST /api/teams — creates team\\n- GET /api/teams/:id — fetches team\\n` +
    `You can now integrate these in the frontend."})\n\n` +
    `// Bad — vague, no details\n` +
    `send_team_message({sessionId: "...", message: "Done with my part"})\n` +
    `\`\`\`\n\n`;

  // Parallel work rules
  msg +=
    `## Parallel Work Rules\n\n` +
    `- **Stay in your lane**: Only modify files within your subtask scope. If you need to change a shared file, message the team first.\n` +
    `- **Don't duplicate work**: If another agent is responsible for a module, don't rewrite it.\n` +
    `- **Read before writing shared files**: \`git diff\` or read the file first — another agent may have changed it.\n` +
    `- **Progress notes are visible to the lead**: Use \`add_progress_note\` to report milestones. The lead sees these via \`get_team_status\`.\n\n`;

  // Available tools
  msg +=
    `## Available Team Tools\n\n` +
    `| Tool | Purpose |\n` +
    `|------|---------|\n` +
    `| \`send_team_message({sessionId, message})\` | Send a message to any teammate or the lead |\n` +
    `| \`get_teammates()\` | Discover your team roster + session IDs |\n` +
    `| \`add_progress_note({note})\` | Report progress (visible to lead via get_team_status) |\n` +
    `| \`get_my_task()\` | Read your assigned subtask details |\n` +
    `| \`update_task({taskId, status})\` | Mark your subtask done when complete |\n` +
    `---\n`;

  return msg;
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

export async function handleGetTeammates(): Promise<{
  parentTaskId: string;
  mySessionId: string;
  teammates: Array<{
    subtaskId: string;
    role: string;
    agent: string | null;
    sessionId: string | null;
    status: string;
  }>;
}> {
  const taskId = process.env.AGENDO_TASK_ID;
  if (!taskId) {
    throw new Error('AGENDO_TASK_ID not set — cannot determine team membership');
  }

  const mySessionId = process.env.AGENDO_SESSION_ID ?? '';

  // Get my task to find parent
  const myTask = (await apiCall(`/api/tasks/${taskId}`)) as {
    id: string;
    parentTaskId: string | null;
  };

  if (!myTask.parentTaskId) {
    throw new Error('This task is not part of a team (no parentTaskId)');
  }

  // Get all sibling subtasks under the parent
  const subtasks = (await apiCall(
    `/api/tasks/${myTask.parentTaskId}/subtasks`,
  )) as SubtaskWithAssignee[];

  // For each subtask, look up its active session
  const teammates = await Promise.all(
    subtasks.map(async (subtask) => {
      const sessions = (await apiCall(`/api/sessions?taskId=${subtask.id}`)) as SessionInfo[];
      const activeSession = sessions.length > 0 ? sessions[0] : null;

      return {
        subtaskId: subtask.id,
        role: subtask.title,
        agent: subtask.assignee?.slug ?? null,
        sessionId: activeSession?.id ?? null,
        status: subtask.status,
      };
    }),
  );

  return {
    parentTaskId: myTask.parentTaskId,
    mySessionId,
    teammates,
  };
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
  model: z
    .string()
    .optional()
    .describe(
      'AI model override. IMPORTANT: match model to task complexity. Use "haiku" for simple/quick tasks (file ops, formatting, counting, small edits). Use "sonnet" for moderate tasks (feature implementation, refactoring, code review). Use "opus" only for complex reasoning (architecture design, multi-file features, debugging subtle issues). Omitting defaults to the agent\'s configured model (often the most expensive).',
    ),
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

  server.tool(
    'get_teammates',
    'Get your team roster — team lead and sibling agents working on the same parent task. Use this to discover who you can message with send_team_message. Only works for agents that are part of a team (task has a parentTaskId).',
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    () => wrapToolCall(() => handleGetTeammates()),
  );
}
