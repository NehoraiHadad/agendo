import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

// ---------------------------------------------------------------------------
// Gemini synthetic NDJSON event types
// ---------------------------------------------------------------------------
// These are emitted by gemini-adapter.ts as JSON lines so that
// session-process.ts can parse them through the standard NDJSON pipeline
// and delegate to mapJsonToEvents (this file).
// ---------------------------------------------------------------------------

export type GeminiEvent =
  | { type: 'gemini:text'; text: string }
  | { type: 'gemini:text-delta'; text: string }
  | { type: 'gemini:thinking'; text: string }
  | { type: 'gemini:thinking-delta'; text: string }
  | {
      type: 'gemini:tool-start';
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId: string;
    }
  | { type: 'gemini:tool-end'; toolUseId: string; resultText?: string; failed?: boolean }
  | { type: 'gemini:turn-complete'; result: Record<string, unknown> }
  | { type: 'gemini:turn-error'; message: string }
  | { type: 'gemini:init'; model: string; sessionId: string }
  | {
      type: 'gemini:plan';
      entries: Array<{ content: string; priority: string; status: string }>;
    }
  | { type: 'gemini:mode-change'; modeId: string }
  | { type: 'gemini:usage'; used: number; size: number };

// ---------------------------------------------------------------------------
// Main mapper: GeminiEvent → AgendoEventPayload[]
// ---------------------------------------------------------------------------

export function mapGeminiJsonToEvents(event: GeminiEvent): AgendoEventPayload[] {
  switch (event.type) {
    // -----------------------------------------------------------------------
    // gemini:init → session:init with model (synthetic, emitted by adapter)
    // -----------------------------------------------------------------------
    case 'gemini:init':
      return [
        {
          type: 'session:init',
          sessionRef: event.sessionId,
          slashCommands: [],
          mcpServers: [],
          model: event.model,
        },
      ];

    // -----------------------------------------------------------------------
    // gemini:text → agent:text
    // -----------------------------------------------------------------------
    case 'gemini:text':
      return [{ type: 'agent:text', text: event.text }];

    // -----------------------------------------------------------------------
    // gemini:text-delta → agent:text-delta (streaming chunk)
    // -----------------------------------------------------------------------
    case 'gemini:text-delta':
      return [{ type: 'agent:text-delta', text: event.text }];

    // -----------------------------------------------------------------------
    // gemini:thinking → agent:thinking
    // -----------------------------------------------------------------------
    case 'gemini:thinking':
      return [{ type: 'agent:thinking', text: event.text }];

    // -----------------------------------------------------------------------
    // gemini:thinking-delta → agent:thinking-delta (streaming chunk)
    // -----------------------------------------------------------------------
    case 'gemini:thinking-delta':
      return [{ type: 'agent:thinking-delta', text: event.text }];

    // -----------------------------------------------------------------------
    // gemini:tool-start → agent:tool-start
    // -----------------------------------------------------------------------
    case 'gemini:tool-start':
      return [buildToolStartEvent(event.toolUseId, event.toolName, event.toolInput)];

    // -----------------------------------------------------------------------
    // gemini:tool-end → agent:tool-end
    // -----------------------------------------------------------------------
    case 'gemini:tool-end':
      return [buildToolEndEvent(event.toolUseId, event.resultText ?? '')];

    // -----------------------------------------------------------------------
    // gemini:turn-complete → agent:result
    // -----------------------------------------------------------------------
    case 'gemini:turn-complete': {
      const result: AgendoEventPayload = {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
      };

      const usage = event.result?.usage as
        | { inputTokens?: number; outputTokens?: number }
        | undefined;
      if (usage && (usage.inputTokens || usage.outputTokens)) {
        (result as Record<string, unknown>).modelUsage = {
          gemini: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            costUSD: 0,
          },
        };
      }
      return [result];
    }

    // -----------------------------------------------------------------------
    // gemini:turn-error → agent:result (isError) + system:error
    // -----------------------------------------------------------------------
    case 'gemini:turn-error':
      return [
        {
          type: 'agent:result',
          costUsd: null,
          turns: 1,
          durationMs: null,
          isError: true,
          errors: [event.message],
        },
        {
          type: 'system:error',
          message: `Gemini turn failed: ${event.message}`,
        },
      ];

    // -----------------------------------------------------------------------
    // gemini:plan → agent:plan (Gemini plan mode execution steps)
    // -----------------------------------------------------------------------
    case 'gemini:plan':
      return [
        {
          type: 'agent:plan',
          entries: event.entries.map((e) => ({
            content: e.content,
            priority: e.priority as 'high' | 'medium' | 'low',
            status: e.status as 'pending' | 'in_progress' | 'completed',
          })),
        },
      ];

    // -----------------------------------------------------------------------
    // gemini:mode-change → session:mode-change (permission mode updated)
    // -----------------------------------------------------------------------
    case 'gemini:mode-change': {
      const modeMap: Record<string, string> = {
        default: 'default',
        autoEdit: 'acceptEdits',
        yolo: 'bypassPermissions',
        plan: 'plan',
      };
      const mode = modeMap[event.modeId] ?? event.modeId;
      return [{ type: 'session:mode-change', mode }];
    }

    // -----------------------------------------------------------------------
    // gemini:usage → agent:usage (real-time context window stats)
    // -----------------------------------------------------------------------
    case 'gemini:usage':
      return [{ type: 'agent:usage', used: event.used, size: event.size }];

    default:
      return [];
  }
}
