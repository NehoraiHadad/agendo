import type { AgendoEvent, AgendoEventPayload, BrainstormEvent } from './event-types';

// ============================================================================
// Agendo-emitted event types
// ============================================================================

/**
 * Event types that Agendo emits via SessionProcess.emitEvent() but which
 * do NOT appear in CLI-native history (adapter.getHistory()).
 *
 * These events are conversation-level (user-visible in the chat UI) but
 * only exist in the Agendo log file. CLI-native history reconstructs
 * conversation from the agent's own storage (e.g. Claude JSONL), which
 * never includes Agendo-specific events.
 *
 * When CLI-native history is the primary catchup source (tier 1 in
 * worker-sse.ts), these events must be supplemented from the log file.
 */
export const AGENDO_CONVERSATION_EVENT_TYPES = new Set([
  'user:message',
  'user:message-cancelled',
] as const);

type AgendoConversationEventType =
  typeof AGENDO_CONVERSATION_EVENT_TYPES extends Set<infer T> ? T : never;

// ============================================================================
// Serialization helpers
// ============================================================================

/**
 * Serialize an AgendoEvent to a log file line.
 * Format: "[{id}|{type}] {json}\n"
 */
export function serializeEvent(event: AgendoEvent): string {
  return `[${event.id}|${event.type}] ${JSON.stringify(event)}\n`;
}

/**
 * Deserialize a log file line back to an AgendoEvent.
 * Returns null if the line is not a valid event.
 */
export function deserializeEvent(line: string): AgendoEvent | null {
  const match = line.match(/^\[(\d+)\|([^\]]+)\] (.+)$/);
  if (!match) return null;
  try {
    return JSON.parse(match[3]) as AgendoEvent;
  } catch {
    return null;
  }
}

/**
 * Generic log file event reader with ID-reset detection.
 *
 * Handles event ID resets that occur after session/room restarts (cold resume).
 * When a session is resumed, the event sequence counter resets to a lower
 * number. Without special handling, all events from the new run with IDs
 * below the previous max would be silently skipped — causing missing
 * messages and merged chat bubbles in the UI.
 *
 * Detection: when we see an event ID significantly lower than the previous
 * max, we treat it as a reset boundary and include ALL events from that
 * point forward (by setting the filter threshold to 0).
 *
 * @param parser - receives a prefix-stripped line, returns a parsed event or null
 */
function readEventsFromLogGeneric<T extends { id: number }>(
  logContent: string,
  afterSeq: number,
  parser: (line: string) => T | null,
): T[] {
  const events: T[] = [];
  let maxSeenId = 0;
  let filterThreshold = afterSeq;

  for (const rawLine of logContent.split('\n')) {
    if (!rawLine.trim()) continue;
    // Log writer prepends "[stdout] ", "[system] " etc. Strip that prefix before
    // trying to deserialize a structured event line.
    const line = rawLine.replace(/^\[(stdout|stderr|system|user)\] /, '');
    const event = parser(line);
    if (!event) continue;

    // Detect ID reset: if the current event's ID drops significantly below
    // the max we've seen, a session/orchestrator restart happened. Reset the
    // filter threshold so all events from the new run are included.
    // Use a relative threshold (50% drop) instead of a fixed one — short
    // orchestrator lifecycles (<100 events) would not trigger the old
    // fixed threshold of 100, causing events from resumed runs to be skipped.
    const resetThreshold = Math.max(maxSeenId - 5, Math.floor(maxSeenId * 0.5));
    if (event.id < resetThreshold && filterThreshold > 0) {
      filterThreshold = 0;
    }
    if (event.id > maxSeenId) {
      maxSeenId = event.id;
    }

    if (event.id > filterThreshold) {
      events.push(event);
    }
  }
  return events;
}

/**
 * Read all events from a session log file with seq > afterSeq.
 * Used for SSE reconnect catchup.
 */
export function readEventsFromLog(logContent: string, afterSeq: number): AgendoEvent[] {
  return readEventsFromLogGeneric(logContent, afterSeq, deserializeEvent);
}

/**
 * Read BrainstormEvents from a brainstorm log file with seq > afterSeq.
 * Uses the same log format as session events: [system] [{id}|{type}] {json}
 * but parses as BrainstormEvent (which has roomId instead of sessionId).
 */
export function readBrainstormEventsFromLog(
  logContent: string,
  afterSeq: number,
): BrainstormEvent[] {
  return readEventsFromLogGeneric(logContent, afterSeq, (line) => {
    const match = line.match(/^\[(\d+)\|([^\]]+)\] (.+)$/);
    if (!match) return null;
    try {
      return JSON.parse(match[3]) as BrainstormEvent;
    } catch {
      return null;
    }
  });
}

// ============================================================================
// Agendo conversation supplement — events missing from CLI-native history
// ============================================================================

/**
 * Extract Agendo-emitted conversation events from a log file that CLI-native
 * history (adapter.getHistory()) does not include.
 *
 * Use case: when CLI history is the primary catchup source (live session with
 * Claude), mid-turn user messages are embedded as system-reminders inside
 * the assistant turn — not as separate user records. This function reads
 * those missing events from the log file so they can supplement CLI history.
 *
 * Deduplication: accepts an optional set of user message texts already present
 * in CLI history (from mapJsonlUserRecord). Only events whose text is NOT in
 * that set are returned, preventing duplicates for messages that DID become
 * separate user turns in the CLI's own history.
 *
 * @param logContent - Raw log file content
 * @param cliUserTexts - Set of user:message texts already sent from CLI history (for dedup)
 * @returns AgendoEvent[] of supplemental conversation events, preserving original IDs/timestamps
 */
export function readAgendoConversationSupplements(
  logContent: string,
  cliUserTexts?: Set<string>,
): AgendoEvent[] {
  const allEvents = readEventsFromLog(logContent, 0);

  return allEvents.filter((event) => {
    if (!isAgendoConversationEvent(event.type)) return false;

    // Deduplicate user:message events that already appear in CLI history.
    // A message that created a proper user turn in CLI storage would appear
    // in both sources — keep only the ones CLI history missed.
    if (cliUserTexts && event.type === 'user:message') {
      const text = (event as AgendoEvent & { type: 'user:message' }).text;
      if (cliUserTexts.has(text)) {
        // Remove from set so duplicate texts (user sent same message twice)
        // only dedup once — subsequent identical messages are kept.
        cliUserTexts.delete(text);
        return false;
      }
    }

    return true;
  });
}

/**
 * Type guard: check if an event type is an Agendo-emitted conversation event.
 */
function isAgendoConversationEvent(type: string): type is AgendoConversationEventType {
  return AGENDO_CONVERSATION_EVENT_TYPES.has(type as AgendoConversationEventType);
}

/**
 * Collect user:message texts from an array of AgendoEventPayload (CLI history output).
 * Returns a mutable Set for use with readAgendoConversationSupplements().
 */
export function collectUserMessageTexts(events: AgendoEventPayload[]): Set<string> {
  const texts = new Set<string>();
  for (const event of events) {
    if (event.type === 'user:message') {
      texts.add((event as AgendoEventPayload & { type: 'user:message' }).text);
    }
  }
  return texts;
}
