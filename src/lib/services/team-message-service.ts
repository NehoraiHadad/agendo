/**
 * Sends a message to a session. Handles both hot (active/awaiting_input)
 * and cold (idle/ended) sessions.
 *
 * This is extracted so both team-creation-service and team-tools (MCP)
 * can send team context messages without duplicating the dispatch logic.
 */
import { getSession } from '@/lib/services/session-service';
import { sendSessionControl } from '@/lib/realtime/worker-client';
import { dispatchSession } from '@/lib/services/session-dispatch';
import { trackTeamMessage } from '@/lib/services/team-telemetry';
import type { AgendoControl } from '@/lib/realtime/events';

export interface TeamMessageMeta {
  parentTaskId?: string;
  senderSessionId?: string;
  direction?: 'lead_to_member' | 'member_to_lead' | 'member_to_member';
}

export async function sendTeamMessage(
  sessionId: string,
  message: string,
  meta?: TeamMessageMeta,
): Promise<{ delivered?: boolean; resuming?: boolean }> {
  const session = await getSession(sessionId);

  // Cold path: session hasn't started yet or has ended
  if (session.status === 'idle' || session.status === 'ended') {
    await dispatchSession({
      sessionId,
      resumeRef: session.sessionRef ?? undefined,
      resumePrompt: message,
      skipResumeContext: true,
    });
    return { resuming: true };
  }

  // Hot path: session is alive
  const control: AgendoControl = { type: 'message', text: message };
  const result = await sendSessionControl(sessionId, control);

  // Fallback to cold resume if worker doesn't have the process
  if (!result.dispatched) {
    await dispatchSession({
      sessionId,
      resumeRef: session.sessionRef ?? undefined,
      resumePrompt: message,
      skipResumeContext: true,
    });
    return { resuming: true };
  }

  // Track telemetry if metadata provided
  if (meta?.parentTaskId && meta.senderSessionId && meta.direction) {
    trackTeamMessage({
      parentTaskId: meta.parentTaskId,
      senderSessionId: meta.senderSessionId,
      recipientSessionId: sessionId,
      direction: meta.direction,
    });
  }

  return { delivered: true };
}
