/**
 * Brainstorm history reconstruction from participant session getHistory().
 *
 * Each brainstorm participant is a regular session. Each adapter implements
 * getHistory() which returns AgendoEventPayload[]. The nth agent:text event
 * in a participant's history corresponds to wave n of the brainstorm.
 *
 * This module provides two exports:
 *
 * - getBrainstormHistoryFromSessions(): Used by handleBrainstormSSE() for
 *   SSE reconnect catchup. Returns BrainstormEvents to emit on the wire.
 *
 * - buildTranscriptFromSessions(): Used by runSynthesis() to build a text
 *   transcript for the synthesis agent. Returns a formatted string or null
 *   if no history is available.
 */

import { createLogger } from '@/lib/logger';
import { getSessionProc } from '@/lib/worker/session-runner';
import type { BrainstormWithDetails } from '@/lib/services/brainstorm-service';
import type { BrainstormEvent } from '@/lib/realtime/event-types';
import type { AgendoEventPayload } from '@/lib/realtime/events';

const log = createLogger('brainstorm-history');

// ============================================================================
// Internal types
// ============================================================================

/** One participant's contribution to a single wave. */
interface WaveMessage {
  wave: number;
  agentId: string;
  agentName: string;
  content: string;
  isPass: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract agent:text payloads from a session history, indexed by turn number.
 * Turn 0 = wave 0, turn 1 = wave 1, etc.
 *
 * We count only the "final" agent:text events (not deltas). A turn boundary
 * is detected by seeing a user:message after an agent:text — indicating the
 * agent responded and the next prompt was sent.
 */
function extractAgentTurns(history: AgendoEventPayload[]): string[] {
  const turns: string[] = [];
  let currentTurnText = '';
  let inTurn = false;

  for (const payload of history) {
    if (payload.type === 'user:message') {
      // If we were in a turn (agent had responded), finalize it
      if (inTurn && currentTurnText) {
        turns.push(currentTurnText.trim());
        currentTurnText = '';
        inTurn = false;
      }
      // else: first user:message or consecutive user messages — just skip
    } else if (payload.type === 'agent:text') {
      // Accumulate agent text for this turn (handles chunked text)
      currentTurnText += payload.text ?? '';
      inTurn = true;
    }
    // Ignore other event types (tool calls, system events, etc.)
  }

  // Flush any trailing agent response not followed by a user message
  if (inTurn && currentTurnText) {
    turns.push(currentTurnText.trim());
  }

  return turns;
}

/**
 * Collect wave messages from all participants by calling getHistory() on
 * their live SessionProcess instances.
 *
 * Returns an array of WaveMessage objects, or null if no history was
 * available from any participant.
 */
async function collectWaveMessages(room: BrainstormWithDetails): Promise<WaveMessage[] | null> {
  const participantsWithSessions = room.participants.filter((p) => p.sessionId != null);

  if (participantsWithSessions.length === 0) {
    return null;
  }

  const allWaveMessages: WaveMessage[] = [];
  let anyHistoryFound = false;

  for (const participant of participantsWithSessions) {
    // sessionId is guaranteed non-null here because we filtered above
    const sessionId = participant.sessionId ?? '';
    const proc = getSessionProc(sessionId);
    if (!proc) {
      log.debug(
        { sessionId, agentId: participant.agentId },
        'No live proc for participant, skipping',
      );
      continue;
    }

    let history: AgendoEventPayload[] | null = null;
    try {
      history = await proc.getHistory();
    } catch (err) {
      log.warn(
        { err, sessionId, agentId: participant.agentId },
        'getHistory() failed for participant',
      );
      continue;
    }

    if (!history || history.length === 0) {
      log.debug(
        { sessionId, agentId: participant.agentId },
        'getHistory() returned empty for participant',
      );
      continue;
    }

    anyHistoryFound = true;
    const agentTurns = extractAgentTurns(history);

    for (let wave = 0; wave < agentTurns.length; wave++) {
      const content = agentTurns[wave];
      // Detect PASS: a very short response containing only "PASS" (case-insensitive)
      const isPass = /^\s*PASS\s*$/i.test(content);
      allWaveMessages.push({
        wave,
        agentId: participant.agentId,
        agentName: participant.agentName,
        content,
        isPass,
      });
    }
  }

  if (!anyHistoryFound) {
    return null;
  }

  // Sort by wave first, then by participant order within each wave
  allWaveMessages.sort((a, b) => a.wave - b.wave);

  return allWaveMessages;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build BrainstormEvents from participant session histories for SSE replay.
 *
 * Used by handleBrainstormSSE() as the primary catchup source. Returns an
 * empty array if no history is available (caller should fall back to log file).
 *
 * Event ordering: wave 0 all participants → wave 1 all participants → ...
 * IDs are assigned sequentially starting from 1.
 */
export async function getBrainstormHistoryFromSessions(
  room: BrainstormWithDetails,
): Promise<BrainstormEvent[]> {
  const waveMessages = await collectWaveMessages(room);
  if (!waveMessages || waveMessages.length === 0) {
    return [];
  }

  const events: BrainstormEvent[] = [];
  let seq = 1;
  const now = Date.now();

  for (const msg of waveMessages) {
    const event: BrainstormEvent = {
      id: seq++,
      roomId: room.id,
      ts: now,
      type: 'message',
      wave: msg.wave,
      senderType: 'agent',
      agentId: msg.agentId,
      agentName: msg.agentName,
      content: msg.content,
      isPass: msg.isPass,
    };
    events.push(event);
  }

  log.info(
    { roomId: room.id, eventCount: events.length },
    'Brainstorm history reconstructed from session getHistory()',
  );

  return events;
}

/**
 * Build a text transcript from participant session histories for synthesis.
 *
 * Used by runSynthesis() as the primary transcript source. Returns null if
 * no history is available (caller should fall back to log file).
 *
 * Format mirrors the existing log-based transcript in runSynthesis():
 * "Wave N — [AgentName]:\n{content}"
 */
export async function buildTranscriptFromSessions(
  room: BrainstormWithDetails,
): Promise<string | null> {
  const waveMessages = await collectWaveMessages(room);
  if (!waveMessages || waveMessages.length === 0) {
    return null;
  }

  const lines = waveMessages.map((msg) => {
    const passNote = msg.isPass ? ' [PASSED]' : '';
    return `Wave ${msg.wave} — [${msg.agentName}]${passNote}:\n${msg.content}`;
  });

  return lines.join('\n\n---\n\n');
}
