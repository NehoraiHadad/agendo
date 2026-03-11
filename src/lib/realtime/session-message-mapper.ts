/**
 * Maps SessionMessage[] (from Claude SDK's getSessionMessages()) to AgendoEvent[].
 *
 * SessionMessage is the historical message format returned by the Claude Agent SDK
 * when reading from Claude's JSONL transcript files (~/.claude/projects/…).
 *
 * Unlike SDKMessage (live stream), SessionMessage only has type 'user' | 'assistant'
 * — no system, result, stream_event, etc. This covers the core conversation content:
 * agent text, tool calls, and tool results.
 *
 * This is used by the SSE catchup phase for Claude sessions as a cleaner alternative
 * to parsing the agendo log file. Non-Claude sessions (Codex, Gemini) fall back to
 * the log file because they have no sessionRef.
 */

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgendoEvent, AgendoEventPayload } from './event-types';
import { buildToolStartEvent, buildToolEndEvent } from './event-builders';

// ---------------------------------------------------------------------------
// Internal content block shapes as stored in Claude's JSONL transcript
// ---------------------------------------------------------------------------

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

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
}

type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { type: string };

interface AssistantMessageParam {
  role: 'assistant';
  content: ContentBlock[];
}

interface UserMessageParam {
  role: 'user';
  content: string | ContentBlock[];
}

type MessageParam = AssistantMessageParam | UserMessageParam;

// ---------------------------------------------------------------------------
// Per-message mapping
// ---------------------------------------------------------------------------

/**
 * Map a single SessionMessage to an array of AgendoEventPayloads.
 *
 * Produces the same event shapes as mapSdkMessageToAgendoEvents() does for the
 * live-stream path, so the UI renders historical and live messages identically.
 *
 * Omissions vs the live path (intentional):
 * - thinking blocks: live path emits via stream_event/thinking_delta (not assistant msg);
 *   we skip here for consistency — the transcript has them but the log file never did.
 * - system / result / stream_event messages: not present in SessionMessage (historical only).
 */
function mapSessionMessageToPayloads(msg: SessionMessage): AgendoEventPayload[] {
  const message = msg.message as MessageParam | undefined;
  if (!message) return [];

  const events: AgendoEventPayload[] = [];

  if (msg.type === 'assistant') {
    const content = (message as AssistantMessageParam).content;
    if (!Array.isArray(content)) return events;

    for (const block of content as ContentBlock[]) {
      if (block.type === 'text') {
        const textBlock = block as TextBlock;
        if (textBlock.text) {
          events.push({ type: 'agent:text', text: textBlock.text });
        }
      } else if (block.type === 'tool_use') {
        const toolUseBlock = block as ToolUseBlock;
        events.push(
          buildToolStartEvent(
            toolUseBlock.id ?? '',
            toolUseBlock.name ?? '',
            toolUseBlock.input ?? {},
          ),
        );
      }
      // thinking and other block types are intentionally skipped (see doc above)
    }
  } else if (msg.type === 'user') {
    const content = (message as UserMessageParam).content;

    // Plain string = user text message sent via agendo UI or CLI
    if (typeof content === 'string') {
      if (content.trim()) {
        events.push({ type: 'user:message', text: content });
      }
      return events;
    }

    for (const block of content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        const toolResultBlock = block as ToolResultBlock;
        events.push(
          buildToolEndEvent(toolResultBlock.tool_use_id ?? '', toolResultBlock.content ?? null),
        );
      } else if (block.type === 'text') {
        // User text within a multi-block message (e.g. text + image)
        const textBlock = block as TextBlock;
        if (textBlock.text?.trim()) {
          events.push({ type: 'user:message', text: textBlock.text });
        }
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map an array of SessionMessages to AgendoEvents with synthetic sequential IDs.
 *
 * IDs start at 1 and increment for each emitted event. Only events with id > afterSeq
 * are returned, enabling reconnect-safe catchup (same semantics as readEventsFromLog).
 *
 * The synthetic IDs are designed to be always smaller than the live session.eventSeq
 * counter, because:
 * - Each SDKMessage generates 1–N events, but eventSeq also counts system/result events
 *   (init, result, compact, etc.) which inflate it beyond the raw message count.
 * - In practice, session.eventSeq >> number of messages × avg blocks per message.
 *
 * The client-side dedup guard (`if (event.id > 0 && events.some(e => e.id === event.id))`)
 * prevents any duplicate rendering even if IDs happen to overlap in unusual sessions.
 *
 * @param messages  Array returned by getSessionMessages()
 * @param sessionId Agendo session UUID (not the Claude sessionRef)
 * @param afterSeq  Last event ID the client has already seen (0 = send everything)
 * @returns         AgendoEvents with id > afterSeq, in conversation order
 */
export function mapSessionMessagesToEvents(
  messages: SessionMessage[],
  sessionId: string,
  afterSeq: number,
): AgendoEvent[] {
  const result: AgendoEvent[] = [];
  let seq = 0;
  const ts = Date.now();

  for (const msg of messages) {
    const payloads = mapSessionMessageToPayloads(msg);
    for (const payload of payloads) {
      seq++;
      if (seq > afterSeq) {
        result.push({
          id: seq,
          sessionId,
          ts,
          ...(payload as object),
        } as AgendoEvent);
      }
    }
  }

  return result;
}
