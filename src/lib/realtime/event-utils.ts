import type { AgendoEvent, BrainstormEvent } from './event-types';

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

// ============================================================================
// Paginated event reading (for REST history endpoint)
// ============================================================================

/** Ephemeral event types excluded from history replay (streaming fragments). */
const EPHEMERAL_EVENT_TYPES = new Set(['agent:text-delta', 'agent:thinking-delta']);

export interface PaginatedEventsResult {
  /** Events in chronological order (oldest first). */
  events: AgendoEvent[];
  /** True if there are older events before the first returned event. */
  hasMore: boolean;
  /** Total number of displayable events in the log (excluding ephemeral). */
  totalCount: number;
  /** Sequence ID of the oldest returned event, or null if empty. */
  oldestSeq: number | null;
  /** Sequence ID of the newest returned event, or null if empty. */
  newestSeq: number | null;
}

export interface PaginatedEventsOptions {
  /** Return events with id < beforeSeq (for scrolling back). */
  beforeSeq?: number;
  /** Return events with id > afterSeq (for scrolling forward). */
  afterSeq?: number;
  /** Maximum number of events to return. If omitted, returns all. */
  limit?: number;
}

/**
 * Read events from a session log file with cursor-based pagination.
 *
 * Unlike `readEventsFromLog()` (designed for SSE reconnect catchup), this
 * function supports bidirectional cursors and limits — designed for REST
 * API endpoints that need paginated history for scroll-back.
 *
 * Ephemeral events (text-delta, thinking-delta) are always excluded.
 */
export function readPaginatedEventsFromLog(
  logContent: string,
  options: PaginatedEventsOptions,
): PaginatedEventsResult {
  const { beforeSeq, afterSeq, limit } = options;

  // Parse all displayable events from the log
  const allEvents: AgendoEvent[] = [];
  for (const rawLine of logContent.split('\n')) {
    if (!rawLine.trim()) continue;
    const line = rawLine.replace(/^\[(stdout|stderr|system|user)\] /, '');
    const event = deserializeEvent(line);
    if (!event) continue;
    if (EPHEMERAL_EVENT_TYPES.has(event.type)) continue;
    allEvents.push(event);
  }

  const totalCount = allEvents.length;

  if (totalCount === 0) {
    return { events: [], hasMore: false, totalCount: 0, oldestSeq: null, newestSeq: null };
  }

  // Apply cursor filters
  let filtered = allEvents;
  if (beforeSeq != null) {
    filtered = filtered.filter((e) => e.id < beforeSeq);
  }
  if (afterSeq != null) {
    filtered = filtered.filter((e) => e.id > afterSeq);
  }

  // Apply limit (take from the END for beforeSeq/no-cursor, from the START for afterSeq)
  let hasMore = false;
  if (limit != null && filtered.length > limit) {
    hasMore = true;
    if (afterSeq != null) {
      // Forward pagination: take first `limit` events
      filtered = filtered.slice(0, limit);
    } else {
      // Backward pagination or default: take last `limit` events
      filtered = filtered.slice(filtered.length - limit);
    }
  } else if (
    beforeSeq != null &&
    filtered.length < allEvents.length - (allEvents.length - filtered.length)
  ) {
    // Check if there are events before our filtered set (without limit truncation)
    // This is needed when limit wasn't exceeded but beforeSeq excluded some events
  }

  // Determine hasMore: are there events older than the oldest returned event?
  if (!hasMore && filtered.length > 0) {
    const oldestReturned = filtered[0].id;
    hasMore = allEvents.some((e) => e.id < oldestReturned);
  }

  return {
    events: filtered,
    hasMore,
    totalCount,
    oldestSeq: filtered.length > 0 ? filtered[0].id : null,
    newestSeq: filtered.length > 0 ? filtered[filtered.length - 1].id : null,
  };
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
