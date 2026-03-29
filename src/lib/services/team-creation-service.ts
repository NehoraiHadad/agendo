/**
 * Shared team-creation service — single path for both MCP `create_team` and UI canvas.
 *
 * Two modes:
 * - `agent_led`: requires leadSessionId, sets parentSessionId, broadcasts team context
 * - `ui_led`: no lead session, no broadcast (reduced coordination)
 */
import { createTask } from '@/lib/services/task-service';
import { createSession } from '@/lib/services/session-service';
import { dispatchSession } from '@/lib/services/session-dispatch';
import { sendTeamMessage } from '@/lib/services/team-message-service';
import { trackTeamCreation } from '@/lib/services/team-telemetry';
import { createLogger } from '@/lib/logger';

const log = createLogger('team-creation-service');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamMemberInput {
  agentId: string;
  role: string;
  prompt: string;
  permissionMode?: 'default' | 'bypassPermissions' | 'acceptEdits';
  model?: string;
}

export interface TeamCreationRequest {
  mode: 'agent_led' | 'ui_led';
  leadSessionId?: string;
  teamName: string;
  members: TeamMemberInput[];
  projectId: string;
  parentTaskId: string;
}

export interface TeamMemberResult {
  agentId: string;
  role: string;
  subtaskId: string;
  sessionId: string;
}

export interface TeamCreationResult {
  parentTaskId: string;
  members: TeamMemberResult[];
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export async function createTeam(request: TeamCreationRequest): Promise<TeamCreationResult> {
  if (request.members.length === 0) {
    throw new Error('At least one team member is required');
  }

  if (request.mode === 'agent_led' && !request.leadSessionId) {
    throw new Error('leadSessionId is required for agent_led mode');
  }

  const results: TeamMemberResult[] = [];

  for (const member of request.members) {
    // 1. Create subtask under parent task
    const task = await createTask({
      title: member.role,
      parentTaskId: request.parentTaskId,
      assigneeAgentId: member.agentId,
      projectId: request.projectId,
    });

    // 2. Create session with proper team metadata
    const session = await createSession({
      taskId: task.id,
      agentId: member.agentId,
      initialPrompt: member.prompt,
      permissionMode: member.permissionMode ?? 'bypassPermissions',
      teamRole: 'member',
      delegationPolicy: 'forbid',
      projectId: request.projectId,
      ...(member.model ? { model: member.model } : {}),
      ...(request.leadSessionId ? { parentSessionId: request.leadSessionId } : {}),
    });

    // 3. Dispatch session (enqueue for worker)
    await dispatchSession({
      sessionId: session.id,
      resumePrompt: member.prompt,
    });

    results.push({
      agentId: member.agentId,
      role: member.role,
      subtaskId: task.id,
      sessionId: session.id,
    });
  }

  // 4. Broadcast team context (agent_led only)
  if (request.mode === 'agent_led' && request.leadSessionId) {
    await broadcastTeamContext(request.leadSessionId, results);
  }

  // Track telemetry
  trackTeamCreation({
    source: request.mode === 'agent_led' ? 'mcp' : 'ui',
    mode: request.mode,
    parentTaskId: request.parentTaskId,
    memberCount: results.length,
    hasLeadSession: !!request.leadSessionId,
  });

  log.info(
    {
      mode: request.mode,
      parentTaskId: request.parentTaskId,
      memberCount: results.length,
      leadSessionId: request.leadSessionId,
    },
    'Team created',
  );

  return { parentTaskId: request.parentTaskId, members: results };
}

// ---------------------------------------------------------------------------
// Team context broadcast
// ---------------------------------------------------------------------------

async function broadcastTeamContext(
  leadSessionId: string,
  members: TeamMemberResult[],
): Promise<void> {
  const sends = members.map(async (member) => {
    const message = buildTeamContextMessage(leadSessionId, members, member.sessionId);
    try {
      await sendTeamMessage(member.sessionId, message);
    } catch {
      // Silently ignore — worker may not be ready yet
      log.warn({ sessionId: member.sessionId }, 'Failed to send team context (non-fatal)');
    }
  });

  await Promise.all(sends);
}

/**
 * Build the team context message that gets sent to a worker session.
 * Includes roster, communication instructions, and parallel work rules.
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
      msg += `- **${sibling.role}** — session \`${sibling.sessionId}\`\n`;
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
    `5. **Discovery**: You found a bug, missing dependency, or design issue that affects the team → share immediately\n\n`;

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
