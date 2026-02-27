import { readFileSync } from 'node:fs';
import type { AgendoEvent } from '@/lib/realtime/events';
import type { ConversionResult } from './types';

interface ClaudeBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

interface ClaudeLine {
  type: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  gitBranch?: string;
  isSidechain?: boolean;
  message?: {
    role: string;
    model?: string;
    content: string | ClaudeBlock[];
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
  };
}

const SKIPPED_TYPES = new Set([
  'file-history-snapshot',
  'progress',
  'queue-operation',
  'summary',
  'system',
]);

/**
 * Convert a Claude CLI JSONL file into AgendoEvents.
 */
export function convertClaudeJsonl(jsonlPath: string, sessionId: string): ConversionResult {
  const raw = readFileSync(jsonlPath, 'utf-8');
  return convertClaudeLines(raw, sessionId);
}

/**
 * Convert raw JSONL content (string) into AgendoEvents.
 * Exposed for testing.
 */
export function convertClaudeLines(raw: string, sessionId: string): ConversionResult {
  let seq = 0;
  const events: AgendoEvent[] = [];
  let model: string | null = null;
  let totalTurns = 0;
  let sessionRef: string | null = null;
  let firstPrompt: string | null = null;

  function makeBase() {
    return { id: ++seq, sessionId, ts: Date.now() };
  }

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

    // Capture sessionRef from the first message's sessionId field
    if (!sessionRef && line.sessionId) {
      sessionRef = line.sessionId;
    }

    const msg = line.message;
    if (!msg) continue;

    const ts = line.timestamp ? new Date(line.timestamp).getTime() : Date.now();

    if (line.type === 'user' && msg.role === 'user') {
      const text = extractUserText(msg.content);
      const toolResults = extractToolResults(msg.content);

      if (text) {
        if (!firstPrompt) firstPrompt = text;
        events.push({ ...makeBase(), ts, type: 'user:message', text });
      }

      for (const tr of toolResults) {
        events.push({
          ...makeBase(),
          ts,
          type: 'agent:tool-end',
          toolUseId: tr.toolUseId,
          content: tr.content,
        });
      }
    }

    if (line.type === 'assistant' && msg.role === 'assistant') {
      if (msg.model && !model) model = msg.model;

      const blocks = Array.isArray(msg.content) ? msg.content : [];

      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) {
          events.push({ ...makeBase(), ts, type: 'agent:thinking', text: block.thinking });
        }

        if (block.type === 'text' && block.text) {
          events.push({ ...makeBase(), ts, type: 'agent:text', text: block.text });
        }

        if (block.type === 'tool_use' && block.id && block.name) {
          events.push({
            ...makeBase(),
            ts,
            type: 'agent:tool-start',
            toolUseId: block.id,
            toolName: block.name,
            input: (block.input as Record<string, unknown>) ?? {},
          });
        }
      }

      if (msg.stop_reason === 'end_turn') {
        totalTurns++;
        events.push({
          ...makeBase(),
          ts,
          type: 'agent:result',
          costUsd: null,
          turns: totalTurns,
          durationMs: null,
        });
      }
    }
  }

  return {
    events,
    metadata: {
      model,
      totalTurns,
      sessionRef: sessionRef ?? sessionId,
      firstPrompt,
    },
  };
}

function extractUserText(content: string | ClaudeBlock[]): string | null {
  if (typeof content === 'string') return content;
  const textBlocks = content
    .filter(
      (b): b is ClaudeBlock & { text: string } => b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text);
  return textBlocks.length > 0 ? textBlocks.join('\n') : null;
}

function extractToolResults(
  content: string | ClaudeBlock[],
): Array<{ toolUseId: string; content: unknown }> {
  if (typeof content === 'string') return [];
  return content
    .filter(
      (b): b is ClaudeBlock & { tool_use_id: string } =>
        b.type === 'tool_result' && typeof b.tool_use_id === 'string',
    )
    .map((b) => ({ toolUseId: b.tool_use_id, content: b.content ?? null }));
}
