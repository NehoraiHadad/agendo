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
 * Read all events from a session log file with seq > afterSeq.
 * Used for SSE reconnect catchup.
 *
 * Handles event ID resets that occur after session restarts (cold resume).
 * When a session is resumed, the event sequence counter resets to a lower
 * number. Without special handling, all events from the new run with IDs
 * below the previous max would be silently skipped — causing missing
 * messages and merged chat bubbles in the UI.
 *
 * Detection: when we see an event ID significantly lower than the previous
 * max, we treat it as a reset boundary and include ALL events from that
 * point forward (by setting the filter threshold to 0).
 */
export function readEventsFromLog(logContent: string, afterSeq: number): AgendoEvent[] {
  const events: AgendoEvent[] = [];
  let maxSeenId = 0;
  let filterThreshold = afterSeq;

  for (const rawLine of logContent.split('\n')) {
    if (!rawLine.trim()) continue;
    // Log writer prepends "[stdout] ", "[system] " etc. Strip that prefix before
    // trying to deserialize a structured event line.
    const line = rawLine.replace(/^\[(stdout|stderr|system|user)\] /, '');
    const event = deserializeEvent(line);
    if (!event) continue;

    // Detect ID reset: if the current event's ID drops significantly below
    // the max we've seen, a session restart happened. Reset the filter
    // threshold so all events from the new run are included.
    if (event.id < maxSeenId - 100 && filterThreshold > 0) {
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
 * Read BrainstormEvents from a brainstorm log file with seq > afterSeq.
 * Uses the same log format as session events: [system] [{id}|{type}] {json}
 * but parses as BrainstormEvent (which has roomId instead of sessionId).
 *
 * Handles event ID resets that occur when the orchestrator restarts (e.g.
 * after a room extension). The same reset detection logic as readEventsFromLog
 * applies: a significant ID drop triggers a filter-threshold reset.
 */
export function readBrainstormEventsFromLog(
  logContent: string,
  afterSeq: number,
): BrainstormEvent[] {
  const events: BrainstormEvent[] = [];
  let maxSeenId = 0;
  let filterThreshold = afterSeq;

  for (const rawLine of logContent.split('\n')) {
    if (!rawLine.trim()) continue;
    const line = rawLine.replace(/^\[(stdout|stderr|system|user)\] /, '');
    const match = line.match(/^\[(\d+)\|([^\]]+)\] (.+)$/);
    if (!match) continue;

    let event: BrainstormEvent;
    try {
      event = JSON.parse(match[3]) as BrainstormEvent;
    } catch {
      continue;
    }

    if (event.id < maxSeenId - 100 && filterThreshold > 0) {
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
