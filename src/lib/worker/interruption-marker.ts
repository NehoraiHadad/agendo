import { createTaskEvent } from '@/lib/services/task-event-service';

/**
 * Describes an agent tool call that was in-flight when the session was interrupted.
 */
export interface InFlightTool {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Build the interruption note text from a list of in-flight tools.
 * This note is written to the task event log so that the cold-resume
 * context preamble can inform the agent that it was interrupted mid-turn.
 */
export function buildInterruptionNote(inflight: InFlightTool[]): string {
  if (inflight.length === 0) {
    return 'Session interrupted mid-turn (worker restart). Verify recent actions before continuing.';
  }
  const MAX_INPUT_LEN = 120;
  const toolSummary = inflight
    .map((t) => {
      const inputStr = JSON.stringify(t.input);
      const truncated =
        inputStr.length > MAX_INPUT_LEN ? inputStr.slice(0, MAX_INPUT_LEN) + '...' : inputStr;
      return `${t.toolName}(${truncated})`;
    })
    .join(', ');
  return (
    `Session interrupted mid-turn. In-flight tool(s): ${toolSummary}. ` +
    `Verify if the last action completed before continuing.`
  );
}

/**
 * Create a task event recording the session interruption.
 * Uses the `agent_note` event type so the note surfaces in the
 * `[Previous Work Summary]` preamble on cold resume.
 */
export async function recordInterruptionEvent(
  taskId: string,
  inflight: InFlightTool[],
  agentId: string,
): Promise<void> {
  const note = buildInterruptionNote(inflight);
  await createTaskEvent({
    taskId,
    actorType: 'system',
    actorId: agentId,
    eventType: 'agent_note',
    payload: { note },
  });
}
