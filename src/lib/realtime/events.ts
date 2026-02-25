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
  | (EventBase & { type: 'agent:text-delta'; text: string })
  | (EventBase & { type: 'agent:thinking'; text: string })
  | (EventBase & { type: 'agent:thinking-delta'; text: string })
  | (EventBase & {
      type: 'agent:tool-start';
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
    })
  | (EventBase & {
      type: 'agent:tool-end';
      toolUseId: string;
      content: unknown;
      durationMs?: number;
      numFiles?: number;
      truncated?: boolean;
    })
  | (EventBase & {
      type: 'agent:result';
      costUsd: number | null;
      turns: number | null;
      durationMs: number | null;
      isError?: boolean;
      subtype?: string;
      errors?: string[];
      durationApiMs?: number | null;
      modelUsage?: Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          costUSD: number;
          contextWindow?: number;
          maxOutputTokens?: number;
        }
      >;
      serviceTier?: string;
      inferenceGeo?: string;
      permissionDenials?: Array<{
        toolName: string;
        toolUseId: string;
        toolInput?: Record<string, unknown>;
      }>;
      serverToolUse?: { webSearchRequests?: number; webFetchRequests?: number };
    })
  | (EventBase & { type: 'agent:activity'; thinking: boolean })
  | (EventBase & {
      type: 'agent:tool-approval';
      approvalId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      dangerLevel: number;
    })
  | (EventBase & {
      type: 'session:init';
      sessionRef: string;
      slashCommands: string[];
      mcpServers: Array<{ name: string; status?: string; tools?: string[] }>;
      model?: string;
      apiKeySource?: string;
      cwd?: string;
      tools?: string[];
      permissionMode?: string;
    })
  | (EventBase & { type: 'session:state'; status: SessionStatus })
  | (EventBase & { type: 'user:message'; text: string; hasImage?: boolean })
  | (EventBase & {
      type: 'system:info';
      message: string;
      compactMeta?: { trigger: 'auto' | 'manual'; preTokens: number };
    })
  | (EventBase & { type: 'system:error'; message: string })
  | (EventBase & {
      type: 'system:mcp-status';
      servers: Array<{ name: string; status: string }>;
    })
  | (EventBase & {
      type: 'system:rate-limit';
      status: string;
      rateLimitType: string;
      resetsAt: number;
      isUsingOverage: boolean;
      overageStatus?: string;
    })
  | (EventBase & {
      type: 'agent:ask-user';
      requestId: string;
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string; markdown?: string }>;
        multiSelect: boolean;
      }>;
    })
  | (EventBase & {
      type: 'team:message';
      /** Slug of the team agent that sent this message (e.g. "mobile-analyst") */
      fromAgent: string;
      /** Raw message text — plain markdown or JSON-encoded structured payload */
      text: string;
      summary?: string;
      /** Agent color hint from the Claude team config (e.g. "blue", "green") */
      color?: string;
      /** Original timestamp from the team inbox file */
      sourceTimestamp: string;
      /** True when text is valid JSON (idle_notification, task_assignment, etc.) */
      isStructured: boolean;
      structuredPayload?: Record<string, unknown>;
    });

export type SessionStatus = 'active' | 'awaiting_input' | 'idle' | 'ended';

// ============================================================================
// AgendoControl — sent by the frontend to the worker via PG NOTIFY
// ============================================================================

export type AgendoControl =
  | { type: 'message'; text: string; imageRef?: { path: string; mimeType: string } }
  | { type: 'cancel' }
  | { type: 'interrupt' }
  | { type: 'redirect'; newPrompt: string }
  | {
      type: 'tool-approval';
      approvalId: string;
      toolName: string;
      decision: 'allow' | 'deny' | 'allow-session';
      /** Modified tool input to send back to Claude (only for 'allow' decisions with edits). */
      updatedInput?: Record<string, unknown>;
    }
  | {
      /** Send a tool_result back to Claude for a pending tool_use (e.g. AskUserQuestion). */
      type: 'tool-result';
      toolUseId: string;
      content: string;
    }
  | {
      /** Answer an AskUserQuestion prompt — keyed by requestId from the agent:ask-user event. */
      type: 'answer-question';
      requestId: string;
      answers: Record<string, string>;
    }
  | {
      /** Change the permission mode of a live session. Worker restarts the process with the new mode. */
      type: 'set-permission-mode';
      mode: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk';
    }
  | {
      /** Switch the AI model of a live session via control_request. */
      type: 'set-model';
      model: string;
    };

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
