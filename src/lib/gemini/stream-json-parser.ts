/**
 * Types and parser for `gemini -p "..." -o stream-json` NDJSON output.
 *
 * Each line is a JSON object with a `type` discriminant. The six event types:
 *   init           — first line, session metadata
 *   message        — user echo (role:'user') or assistant delta (role:'assistant', delta:true)
 *   tool_use       — agent invoked a tool
 *   tool_result    — tool returned a result
 *   result         — final line, status + token stats
 */

export interface StreamJsonInitEvent {
  type: 'init';
  timestamp: string;
  session_id: string;
  model: string;
}

export interface StreamJsonUserMessageEvent {
  type: 'message';
  timestamp: string;
  role: 'user';
  content: string;
}

export interface StreamJsonAssistantDeltaEvent {
  type: 'message';
  timestamp: string;
  role: 'assistant';
  content: string;
  delta: true;
}

export interface StreamJsonToolUseEvent {
  type: 'tool_use';
  timestamp: string;
  tool_name: string;
  tool_id: string;
  parameters: Record<string, unknown>;
}

export interface StreamJsonToolResultEvent {
  type: 'tool_result';
  timestamp: string;
  tool_id: string;
  status: 'success' | 'failed';
  output: string;
}

export interface StreamJsonStats {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached: number;
  duration_ms: number;
  tool_calls: number;
}

export interface StreamJsonResultEvent {
  type: 'result';
  timestamp: string;
  status: 'success' | 'error' | 'cancelled';
  stats?: StreamJsonStats;
}

export type StreamJsonEvent =
  | StreamJsonInitEvent
  | StreamJsonUserMessageEvent
  | StreamJsonAssistantDeltaEvent
  | StreamJsonToolUseEvent
  | StreamJsonToolResultEvent
  | StreamJsonResultEvent;

/**
 * Parse a single NDJSON line. Returns null for blank lines or invalid JSON.
 */
export function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamJsonEvent;
  } catch {
    return null;
  }
}
