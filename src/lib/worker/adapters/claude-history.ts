/**
 * Claude history mapper — converts getSessionMessages() output to AgendoEventPayload[].
 *
 * Used as a fallback when the Agendo session log file is missing/empty.
 * Claude's getSessionMessages() reads the JSONL on disk and returns
 * SessionMessage[] (user + assistant only, with parentUuid chain resolved).
 *
 * Limitations vs the Agendo log file:
 * - No timestamps (stripped by SDK)
 * - No cost/duration data (runtime-only events)
 * - No system events, approvals, team messages, or subagent events
 * - Tool result metadata (durationMs, numFiles) is lost
 *
 * This gives ~60% fidelity — enough for a usable reconnect experience.
 */

import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

// ---------------------------------------------------------------------------
// Types matching the Claude SDK's SessionMessage shape (typed as unknown)
// ---------------------------------------------------------------------------

/** Minimal shape of what getSessionMessages() returns. */
interface SessionMessage {
  type: 'user' | 'assistant';
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: null;
}

/** Content block types found in assistant messages. */
interface TextBlock {
  type: 'text';
  text: string;
}

interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | { type: string };

/** User message content when it's a tool result. */
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map an array of SessionMessage objects (from getSessionMessages()) to
 * AgendoEventPayload[]. The output can be used directly by worker-sse.ts
 * to send catchup events to a reconnecting browser.
 */
export function mapClaudeSessionMessages(messages: unknown[]): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];

  // Build a map of tool_use_id → tool_result content for pairing
  const toolResults = new Map<string, string>();
  for (const raw of messages) {
    const msg = raw as SessionMessage;
    if (msg.type !== 'user') continue;
    const content = (msg.message as { content: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type: string }>) {
      if (block.type === 'tool_result') {
        const tr = block as ToolResultBlock;
        toolResults.set(
          tr.tool_use_id,
          typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
        );
      }
    }
  }

  for (const raw of messages) {
    const msg = raw as SessionMessage;

    if (msg.type === 'user') {
      const userEvents = mapUserMessage(msg);
      events.push(...userEvents);
    } else if (msg.type === 'assistant') {
      const assistantEvents = mapAssistantMessage(msg, toolResults);
      events.push(...assistantEvents);
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// User message mapping
// ---------------------------------------------------------------------------

function mapUserMessage(msg: SessionMessage): AgendoEventPayload[] {
  const msgBody = msg.message as { role: string; content: unknown };
  const content = msgBody.content;

  // String content → simple text message
  if (typeof content === 'string') {
    return [{ type: 'user:message', text: content }];
  }

  // Array content → could be text + image, or tool_result blocks
  if (Array.isArray(content)) {
    const blocks = content as Array<{ type: string; text?: string }>;

    // Skip tool_result user messages — they are paired with tool_use in assistant mapping
    const hasToolResult = blocks.some((b) => b.type === 'tool_result');
    if (hasToolResult) return [];

    // Extract text and check for images
    const textParts: string[] = [];
    let hasImage = false;
    for (const block of blocks) {
      if (block.type === 'text' && block.text) {
        textParts.push(block.text);
      } else if (block.type === 'image') {
        hasImage = true;
      }
    }

    const text = textParts.join('\n');
    if (!text && !hasImage) return [];

    return [{ type: 'user:message', text, ...(hasImage ? { hasImage: true } : {}) }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Assistant message mapping
// ---------------------------------------------------------------------------

function mapAssistantMessage(
  msg: SessionMessage,
  toolResults: Map<string, string>,
): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];
  const msgBody = msg.message as { content?: unknown[] };
  const contentBlocks = (msgBody.content ?? []) as ContentBlock[];

  let hasToolUse = false;

  for (const block of contentBlocks) {
    switch (block.type) {
      case 'thinking': {
        const thinking = block as ThinkingBlock;
        if (thinking.thinking) {
          events.push({ type: 'agent:thinking', text: thinking.thinking });
        }
        break;
      }

      case 'text': {
        const text = block as TextBlock;
        if (text.text) {
          events.push({ type: 'agent:text', text: text.text });
        }
        break;
      }

      case 'tool_use': {
        hasToolUse = true;
        const tool = block as ToolUseBlock;
        events.push(buildToolStartEvent(tool.id, tool.name, tool.input));

        // Pair with tool_result if available
        const result = toolResults.get(tool.id);
        if (result !== undefined) {
          events.push(buildToolEndEvent(tool.id, result));
        }
        break;
      }

      // Skip unknown block types
      default:
        break;
    }
  }

  // Emit agent:result after each assistant turn (unless it was a pure tool_use
  // turn — the result will come after the tool results are processed)
  if (!hasToolUse || contentBlocks.some((b) => b.type === 'text')) {
    events.push({
      type: 'agent:result',
      costUsd: null,
      turns: 1,
      durationMs: null,
    });
  }

  return events;
}
