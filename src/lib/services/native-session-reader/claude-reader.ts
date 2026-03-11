import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import type {
  NativeReadResult,
  NativeReaderOptions,
  NativeTurn,
  NativeToolCall,
  NativeToolResult,
} from './types';

// ---------------------------------------------------------------------------
// Internal types for parsing Claude JSONL
// ---------------------------------------------------------------------------

interface ClaudeBlock {
  type: string;
  text?: string;
  thinking?: string;
  /** tool_use block id */
  id?: string;
  /** tool_use block name */
  name?: string;
  input?: Record<string, unknown>;
  /** tool_result block */
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeLine {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role: string;
    model?: string;
    content: string | ClaudeBlock[];
    stop_reason?: string | null;
  };
}

const SKIPPED_TYPES = new Set([
  'file-history-snapshot',
  'progress',
  'queue-operation',
  'summary',
  'system',
]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function claudeProjectHash(cwd: string): string {
  // Replace every '/' with '-'. Leading slash → leading '-'.
  return cwd.replace(/\//g, '-');
}

function claudeSessionPath(sessionRef: string, cwd: string): string {
  const hash = claudeProjectHash(cwd);
  const home = process.env.HOME ?? '/root';
  return path.join(home, '.claude', 'projects', hash, `${sessionRef}.jsonl`);
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

function extractUserText(content: string | ClaudeBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter(
      (b): b is ClaudeBlock & { text: string } => b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('\n');
}

function extractToolResultContent(content: unknown): { text: string; isError: boolean } {
  if (typeof content === 'string') {
    return { text: content, isError: false };
  }
  if (Array.isArray(content)) {
    // Array of typed blocks
    const parts: string[] = [];
    let isError = false;
    for (const item of content as ClaudeBlock[]) {
      if (item.type === 'text' && typeof item.text === 'string') {
        parts.push(item.text);
      } else if (item.type === 'tool_result_error') {
        isError = true;
        if (typeof item.text === 'string') parts.push(item.text);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return { text: parts.join('\n'), isError };
  }
  if (content === null || content === undefined) {
    return { text: '', isError: false };
  }
  return { text: JSON.stringify(content), isError: false };
}

// ---------------------------------------------------------------------------
// Raw message type (intermediate parse result)
// ---------------------------------------------------------------------------

interface RawMessage {
  role: 'user' | 'assistant';
  text: string;
  toolCalls: NativeToolCall[];
  /** tool_results with raw content before truncation */
  toolResults: Array<{ toolUseId: string; content: string; isError: boolean }>;
}

// ---------------------------------------------------------------------------
// Main reader
// ---------------------------------------------------------------------------

export async function readClaudeSession(
  sessionRef: string,
  cwd: string,
  options?: NativeReaderOptions,
): Promise<NativeReadResult | null> {
  const filePath = claudeSessionPath(sessionRef, cwd);

  // Check file exists
  try {
    await access(filePath);
  } catch {
    return null;
  }

  const raw = await readFile(filePath, 'utf-8');

  const opts: Required<NativeReaderOptions> = {
    includeToolResults: options?.includeToolResults ?? true,
    maxToolResultChars: options?.maxToolResultChars ?? 2000,
    includeBashOutput: options?.includeBashOutput ?? true,
    maxTurns: options?.maxTurns ?? 0,
  };

  // Build a map from toolUseId → toolName (from all assistant messages)
  // so we can filter Bash results later
  const toolNameById = new Map<string, string>();

  // Parse all lines into raw messages
  const rawMessages: RawMessage[] = [];

  for (const rawLine of raw.split('\n')) {
    if (!rawLine.trim()) continue;

    let line: ClaudeLine;
    try {
      line = JSON.parse(rawLine) as ClaudeLine;
    } catch {
      continue;
    }

    if (SKIPPED_TYPES.has(line.type)) continue;
    if (line.isSidechain) continue;

    const msg = line.message;
    if (!msg) continue;

    if (line.type === 'user' && msg.role === 'user') {
      const text = extractUserText(msg.content);
      const blocks = Array.isArray(msg.content) ? msg.content : [];

      // Extract tool_result blocks
      const toolResults: RawMessage['toolResults'] = [];
      for (const block of blocks) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const { text: content, isError } = extractToolResultContent(block.content);
          toolResults.push({
            toolUseId: block.tool_use_id,
            content,
            isError: isError || block.is_error === true,
          });
        }
      }

      // Only push if there's something meaningful
      if (text || toolResults.length > 0) {
        rawMessages.push({ role: 'user', text, toolCalls: [], toolResults });
      }
    } else if (line.type === 'assistant' && msg.role === 'assistant') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];

      let text = '';
      const toolCalls: NativeToolCall[] = [];

      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text += (text ? '\n' : '') + block.text;
        } else if (
          block.type === 'tool_use' &&
          typeof block.id === 'string' &&
          typeof block.name === 'string'
        ) {
          const toolUseId = block.id;
          const toolName = block.name;
          toolNameById.set(toolUseId, toolName);
          toolCalls.push({
            toolUseId,
            toolName,
            input: block.input ?? {},
          });
        }
        // skip 'thinking' blocks
      }

      rawMessages.push({ role: 'assistant', text, toolCalls, toolResults: [] });
    }
  }

  // Build NativeTurns: one per raw message, but attach tool_results from the
  // NEXT user message that contains tool_result blocks to the assistant turn
  // that issued those tool_use calls.
  //
  // Strategy: iterate rawMessages; when we emit an assistant turn, look ahead
  // to see if the next user message consists *only* of tool_results (no text).
  // If so, attach those results to the assistant turn and skip that user message.

  let rawResultChars = 0;
  const allTurns: NativeTurn[] = [];
  let turnIndex = 0;

  let i = 0;
  while (i < rawMessages.length) {
    const rm = rawMessages[i];

    if (rm.role === 'assistant') {
      // Collect tool results for this assistant turn
      let toolResults: NativeToolResult[] = [];

      // Check if next message is a user message that only has tool_results (no text)
      const next = rawMessages[i + 1];
      let skipNext = false;
      if (next && next.role === 'user' && !next.text && next.toolResults.length > 0) {
        skipNext = true;
        for (const tr of next.toolResults) {
          rawResultChars += tr.content.length;

          // Filter Bash output if requested
          if (!opts.includeBashOutput && toolNameById.get(tr.toolUseId) === 'Bash') {
            continue;
          }

          if (opts.includeToolResults) {
            let content = tr.content;
            if (content.length > opts.maxToolResultChars) {
              content = content.slice(0, opts.maxToolResultChars) + '...(truncated)';
            }
            toolResults.push({ toolUseId: tr.toolUseId, content, isError: tr.isError });
          }
        }
      }

      if (!opts.includeToolResults) {
        toolResults = [];
      }

      allTurns.push({
        index: turnIndex++,
        role: 'assistant',
        text: rm.text,
        toolCalls: rm.toolCalls,
        toolResults,
      });

      i += skipNext ? 2 : 1;
    } else {
      // User message — may have text and/or tool_results not already consumed
      // (tool_results here would be ones not preceded by an assistant turn, unusual)
      const userToolResults: NativeToolResult[] = [];

      for (const tr of rm.toolResults) {
        rawResultChars += tr.content.length;

        if (!opts.includeBashOutput && toolNameById.get(tr.toolUseId) === 'Bash') {
          continue;
        }

        if (opts.includeToolResults) {
          let content = tr.content;
          if (content.length > opts.maxToolResultChars) {
            content = content.slice(0, opts.maxToolResultChars) + '...(truncated)';
          }
          userToolResults.push({ toolUseId: tr.toolUseId, content, isError: tr.isError });
        }
      }

      // Only emit a user turn if it has text or leftover tool_results
      if (rm.text || userToolResults.length > 0) {
        allTurns.push({
          index: turnIndex++,
          role: 'user',
          text: rm.text,
          toolCalls: [],
          toolResults: userToolResults,
        });
      }

      i++;
    }
  }

  // Re-index after building
  let finalTurns = allTurns.map((t, idx) => ({ ...t, index: idx }));

  // Apply maxTurns limit (last N turns)
  if (opts.maxTurns > 0 && finalTurns.length > opts.maxTurns) {
    finalTurns = finalTurns.slice(finalTurns.length - opts.maxTurns);
    // Re-index
    finalTurns = finalTurns.map((t, idx) => ({ ...t, index: idx }));
  }

  return {
    turns: finalTurns,
    provider: 'claude',
    sessionId: sessionRef,
    rawResultChars,
  };
}
