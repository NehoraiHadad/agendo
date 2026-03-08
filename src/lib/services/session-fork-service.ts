/**
 * session-fork-service.ts
 *
 * Cross-agent session forking: transfers conversation context from an existing
 * session to a new session running under a different agent.
 *
 * Unlike same-agent forks (forkSession), cross-agent forks cannot use
 * --resume/--fork-session because the session history format is agent-specific.
 * Instead, the full or summarized conversation context is extracted and passed
 * as the initial prompt of the new session.
 */

import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agents, agentCapabilities } from '@/lib/db/schema';
import { getSession, createSession } from '@/lib/services/session-service';
import { extractSessionContext } from '@/lib/services/context-extractor';
// enqueueSession no longer called — session stays idle until user sends first message
// import { enqueueSession } from '@/lib/worker/queue';
import { BadRequestError, ConflictError, NotFoundError } from '@/lib/errors';
import type { Session } from '@/lib/types';
import type { ExtractedContext } from '@/lib/services/context-extractor';

export interface ForkToAgentInput {
  parentSessionId: string;
  newAgentId: string;
  capabilityId?: string;
  contextMode: 'hybrid' | 'full';
  additionalInstructions?: string;
}

export interface ForkToAgentResult {
  session: Session;
  agentName: string;
  contextMeta: ExtractedContext['meta'];
}

/** Session statuses from which a cross-agent fork is permitted. */
const VALID_FORK_STATES = new Set(['active', 'awaiting_input']);

/**
 * Fork an existing session to a different agent.
 *
 * Validates that:
 * - Parent session is in a forkable state (active or awaiting_input)
 * - The new agent differs from the parent's agent
 * - The new agent exists and has at least one enabled capability
 *
 * Extracts the conversation context from the parent's log file and creates a
 * new session for the target agent with the context as its initial prompt.
 * The new session is enqueued immediately.
 */
export async function forkSessionToAgent(input: ForkToAgentInput): Promise<ForkToAgentResult> {
  // 1. Load + validate parent session
  const parent = await getSession(input.parentSessionId);

  if (!VALID_FORK_STATES.has(parent.status)) {
    throw new ConflictError(`Cannot fork session in '${parent.status}' state`, {
      status: parent.status,
    });
  }

  if (parent.agentId === input.newAgentId) {
    throw new BadRequestError(
      'New agent must differ from parent session agent. Use /fork for same-agent branching.',
      { agentId: input.newAgentId },
    );
  }

  // 2. Look up new agent — must exist and be identifiable by name
  const [newAgent] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.id, input.newAgentId))
    .limit(1);

  if (!newAgent) throw new NotFoundError('Agent', input.newAgentId);

  // 3. Look up parent agent name (for context prompt header)
  const [parentAgent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, parent.agentId))
    .limit(1);

  void parentAgent; // Used implicitly via extractSessionContext which reads agentName from DB

  // 4. Resolve capability — validate explicit capabilityId or fall back to first enabled prompt cap
  let capabilityId: string;

  if (input.capabilityId) {
    const [cap] = await db
      .select({
        id: agentCapabilities.id,
        agentId: agentCapabilities.agentId,
        isEnabled: agentCapabilities.isEnabled,
        interactionMode: agentCapabilities.interactionMode,
      })
      .from(agentCapabilities)
      .where(eq(agentCapabilities.id, input.capabilityId))
      .limit(1);

    if (!cap) {
      throw new NotFoundError('Capability', input.capabilityId);
    }
    if (cap.agentId !== input.newAgentId) {
      throw new BadRequestError('Capability does not belong to the target agent', {
        capabilityId: input.capabilityId,
        agentId: input.newAgentId,
      });
    }
    if (!cap.isEnabled) {
      throw new BadRequestError('Capability is not enabled', {
        capabilityId: input.capabilityId,
      });
    }
    if (cap.interactionMode !== 'prompt') {
      throw new BadRequestError('Capability must have interaction mode "prompt" for sessions', {
        capabilityId: input.capabilityId,
        interactionMode: cap.interactionMode,
      });
    }
    capabilityId = cap.id;
  } else {
    const [fallbackCap] = await db
      .select({ id: agentCapabilities.id })
      .from(agentCapabilities)
      .where(
        and(
          eq(agentCapabilities.agentId, input.newAgentId),
          eq(agentCapabilities.isEnabled, true),
          eq(agentCapabilities.interactionMode, 'prompt'),
        ),
      )
      .limit(1);

    if (!fallbackCap) {
      throw new BadRequestError('Target agent has no enabled prompt capability', {
        agentId: input.newAgentId,
      });
    }
    capabilityId = fallbackCap.id;
  }

  // 5. Extract conversation context from the parent session's log
  const extracted = await extractSessionContext(input.parentSessionId, {
    mode: input.contextMode,
  });

  // 6. Build the initial prompt, appending optional additional instructions
  let initialPrompt = extracted.prompt;
  if (input.additionalInstructions) {
    initialPrompt += `\n\n---\n\nAdditional instructions:\n${input.additionalInstructions}`;
  }

  // 7. Create the new session, inheriting relevant parent fields.
  //    Deliberately excluded:
  //    - model: agent-specific; the target agent uses its own default
  //    - forkSourceRef: cross-agent cannot use --resume to inherit parent history
  const newSession = await createSession({
    taskId: parent.taskId ?? undefined,
    projectId: parent.projectId ?? undefined,
    kind: 'conversation',
    agentId: input.newAgentId,
    capabilityId,
    permissionMode: parent.permissionMode as
      | 'default'
      | 'bypassPermissions'
      | 'acceptEdits'
      | 'plan'
      | 'dontAsk',
    allowedTools: parent.allowedTools as string[],
    idleTimeoutSec: parent.idleTimeoutSec,
    initialPrompt,
    parentSessionId: input.parentSessionId,
  });

  // 8. Session is NOT enqueued immediately. User will start it.
  // await enqueueSession({ sessionId: newSession.id });

  return {
    session: newSession,
    agentName: newAgent.name,
    contextMeta: extracted.meta,
  };
}
