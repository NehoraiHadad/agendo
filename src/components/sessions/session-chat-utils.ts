import type { AgendoEvent } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallResult {
  content: string;
  isError: boolean;
}

export interface ToolState {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: ToolCallResult;
}

export type AssistantPart = { kind: 'text'; text: string } | { kind: 'tool'; tool: ToolState };

export type DisplayItem =
  | { kind: 'assistant'; id: number; parts: AssistantPart[] }
  | {
      kind: 'turn-complete';
      id: number;
      text: string;
      costUsd: number | null;
      sessionCostUsd: number | null;
    }
  | { kind: 'thinking'; id: number; text: string }
  | { kind: 'user'; id: number; text: string; hasImage?: boolean }
  | { kind: 'info'; id: number; text: string }
  | { kind: 'error'; id: number; text: string }
  | {
      kind: 'tool-approval';
      id: number;
      approvalId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      dangerLevel: number;
    }
  | {
      kind: 'team-message';
      id: number;
      fromAgent: string;
      text: string;
      summary?: string;
      color?: string;
      isStructured: boolean;
      structuredPayload?: Record<string, unknown>;
      sourceTimestamp: string;
    };

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

/** Extract displayable text from a tool result content value.
 *  MCP tools return content as an array of content blocks: [{type:'text',text:'...'}].
 *  Plain string content is used as-is. Anything else falls back to JSON.stringify. */
export function extractToolContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const texts = raw
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join('\n');
  }
  return JSON.stringify(raw ?? '');
}

export function buildToolResultMap(events: AgendoEvent[]): Map<string, ToolCallResult> {
  const map = new Map<string, ToolCallResult>();
  for (const ev of events) {
    if (ev.type === 'agent:tool-end') {
      map.set(ev.toolUseId, { content: extractToolContent(ev.content), isError: false });
    }
  }
  return map;
}

export function buildDisplayItems(
  events: AgendoEvent[],
  toolResultMap: Map<string, ToolCallResult>,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  // Track pending tool calls so we can hydrate them with results as they arrive
  const pendingTools = new Map<string, ToolState>();
  let sessionInitCount = 0;
  let sessionCostUsd = 0;

  for (const ev of events) {
    switch (ev.type) {
      case 'agent:text': {
        const last = items[items.length - 1];
        if (last && last.kind === 'assistant') {
          // Append to existing text part if the last part is already text
          const lastPart = last.parts[last.parts.length - 1];
          if (lastPart && lastPart.kind === 'text') {
            lastPart.text += ev.text;
          } else {
            last.parts.push({ kind: 'text', text: ev.text });
          }
        } else {
          items.push({ kind: 'assistant', id: ev.id, parts: [{ kind: 'text', text: ev.text }] });
        }
        break;
      }

      case 'agent:thinking': {
        items.push({ kind: 'thinking', id: ev.id, text: ev.text });
        break;
      }

      case 'agent:tool-start': {
        const result = toolResultMap.get(ev.toolUseId);
        const toolState: ToolState = {
          toolUseId: ev.toolUseId,
          toolName: ev.toolName,
          input: ev.input,
          result,
        };
        pendingTools.set(ev.toolUseId, toolState);

        // Append tool part in order within the current assistant bubble
        const last = items[items.length - 1];
        if (last && last.kind === 'assistant') {
          last.parts.push({ kind: 'tool', tool: toolState });
        } else {
          items.push({ kind: 'assistant', id: ev.id, parts: [{ kind: 'tool', tool: toolState }] });
        }
        break;
      }

      case 'agent:tool-end': {
        const pending = pendingTools.get(ev.toolUseId);
        if (pending) {
          pending.result = { content: extractToolContent(ev.content), isError: false };
          pendingTools.delete(ev.toolUseId);
        }
        break;
      }

      case 'agent:tool-approval': {
        // Replace any existing unresolved approval card for the same toolName.
        // Prevents duplicate cards when ExitPlanMode fires twice.
        const supersededIdx = items.findIndex(
          (item) => item.kind === 'tool-approval' && item.toolName === ev.toolName,
        );
        if (supersededIdx !== -1) {
          items.splice(supersededIdx, 1);
        }
        items.push({
          kind: 'tool-approval',
          id: ev.id,
          approvalId: ev.approvalId,
          toolName: ev.toolName,
          toolInput: ev.toolInput,
          dangerLevel: ev.dangerLevel,
        });
        break;
      }

      case 'agent:result': {
        const parts: string[] = ['Turn complete'];
        if (ev.turns != null) parts.push(`${ev.turns} turn${ev.turns !== 1 ? 's' : ''}`);
        if (ev.durationMs != null) parts.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
        if (ev.costUsd != null) sessionCostUsd += ev.costUsd;
        items.push({
          kind: 'turn-complete',
          id: ev.id,
          text: parts.join(' · '),
          costUsd: ev.costUsd ?? null,
          sessionCostUsd: ev.costUsd != null ? sessionCostUsd : null,
        });
        break;
      }

      case 'session:init': {
        sessionInitCount++;
        if (sessionInitCount === 1) {
          items.push({ kind: 'info', id: ev.id, text: 'Session started' });
        }
        break;
      }

      case 'user:message': {
        items.push({ kind: 'user', id: ev.id, text: ev.text, hasImage: ev.hasImage });
        break;
      }

      case 'system:info': {
        items.push({ kind: 'info', id: ev.id, text: ev.message });
        break;
      }

      case 'system:error': {
        items.push({ kind: 'error', id: ev.id, text: ev.message });
        break;
      }

      case 'team:message': {
        items.push({
          kind: 'team-message',
          id: ev.id,
          fromAgent: ev.fromAgent,
          text: ev.text,
          summary: ev.summary,
          color: ev.color,
          isStructured: ev.isStructured,
          structuredPayload: ev.structuredPayload,
          sourceTimestamp: ev.sourceTimestamp,
        });
        break;
      }

      // session:state and agent:activity are handled by the hook, not rendered here
      default:
        break;
    }
  }

  return items;
}
