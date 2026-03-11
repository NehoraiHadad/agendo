export interface NativeToolCall {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface NativeToolResult {
  toolUseId: string;
  /** Raw string content — may be truncated by the reader based on options */
  content: string;
  isError?: boolean;
}

export interface NativeTurn {
  index: number;
  role: 'user' | 'assistant';
  /** Concatenated text blocks */
  text: string;
  toolCalls: NativeToolCall[];
  toolResults: NativeToolResult[];
}

export interface NativeReadResult {
  turns: NativeTurn[];
  provider: 'claude' | 'gemini' | 'codex';
  sessionId: string;
  /** Total chars of raw tool_result content (for budget decisions) */
  rawResultChars: number;
}

export interface NativeReaderOptions {
  /** Include tool result content (file reads, bash output). Default: true */
  includeToolResults?: boolean;
  /** Truncate individual tool results to this many chars. Default: 2000 */
  maxToolResultChars?: number;
  /** Include Bash command stdout/stderr in tool results. Default: true */
  includeBashOutput?: boolean;
  /** Limit to last N turns (0 = unlimited). Default: 0 */
  maxTurns?: number;
}
