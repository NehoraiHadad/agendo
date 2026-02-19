// ============================================================================
// AgendoEvent — emitted by the worker, consumed by the frontend via SSE
// ============================================================================

/** Base fields present on every event */
interface EventBase {
  /** Monotonic sequence number within a session (used as SSE last-event-id) */
  id: number;
  /** UUID of the session this event belongs to */
  sessionId: string;
  /** Unix timestamp ms */
  ts: number;
}

export type AgendoEvent =
  | (EventBase & { type: 'agent:text'; text: string })
  | (EventBase & { type: 'agent:thinking'; text: string })
  | (EventBase & { type: 'agent:tool-start'; toolUseId: string; toolName: string; input: Record<string, unknown> })
  | (EventBase & { type: 'agent:tool-end'; toolUseId: string; content: unknown })
  | (EventBase & { type: 'agent:result'; costUsd: number | null; turns: number | null; durationMs: number | null })
  | (EventBase & { type: 'agent:activity'; thinking: boolean })
  | (EventBase & {
      type: 'agent:tool-approval';
      approvalId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      dangerLevel: number;
    })
  | (EventBase & { type: 'session:init'; sessionRef: string; slashCommands: string[]; mcpServers: Array<{ name: string; status?: string; tools?: string[] }> })
  | (EventBase & { type: 'session:state'; status: SessionStatus })
  | (EventBase & { type: 'user:message'; text: string })
  | (EventBase & { type: 'system:info'; message: string })
  | (EventBase & { type: 'system:error'; message: string });

export type SessionStatus = 'active' | 'awaiting_input' | 'idle' | 'ended';

// ============================================================================
// AgendoControl — sent by the frontend to the worker via PG NOTIFY
// ============================================================================

export type AgendoControl =
  | { type: 'message'; text: string; image?: { mimeType: string; data: string } }
  | { type: 'cancel' }
  | { type: 'interrupt' }
  | { type: 'redirect'; newPrompt: string }
  | { type: 'tool-approval'; approvalId: string; toolName: string; decision: 'allow' | 'deny' | 'allow-session' };

// ============================================================================
// Distributive Omit for AgendoEvent
// ============================================================================

/**
 * Distributive Omit that preserves discriminated union members.
 * Use this instead of plain `Omit<AgendoEvent, Keys>` to avoid collapsing the union.
 */
export type AgendoEventPayload = AgendoEvent extends infer E
  ? E extends AgendoEvent
    ? Omit<E, 'id' | 'sessionId' | 'ts'>
    : never
  : never;

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
 */
export function readEventsFromLog(logContent: string, afterSeq: number): AgendoEvent[] {
  const events: AgendoEvent[] = [];
  for (const rawLine of logContent.split('\n')) {
    if (!rawLine.trim()) continue;
    // Log writer prepends "[stdout] ", "[system] " etc. Strip that prefix before
    // trying to deserialize a structured event line.
    const line = rawLine.replace(/^\[(stdout|stderr|system|user)\] /, '');
    const event = deserializeEvent(line);
    if (event && event.id > afterSeq) {
      events.push(event);
    }
  }
  return events;
}
