import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

// ---------------------------------------------------------------------------
// Copilot synthetic NDJSON event types
// ---------------------------------------------------------------------------
// These are emitted by copilot-adapter.ts as JSON lines so that
// session-process.ts can parse them through the standard NDJSON pipeline
// and delegate to mapJsonToEvents (this file).
// ---------------------------------------------------------------------------

export type CopilotEvent =
  | { type: 'copilot:text'; text: string }
  | { type: 'copilot:text-delta'; text: string }
  | { type: 'copilot:thinking'; text: string }
  | { type: 'copilot:thinking-delta'; text: string }
  | {
      type: 'copilot:tool-start';
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId: string;
    }
  | { type: 'copilot:tool-end'; toolUseId: string; resultText?: string; failed?: boolean }
  | { type: 'copilot:turn-complete'; result: Record<string, unknown> }
  | { type: 'copilot:turn-error'; message: string }
  | { type: 'copilot:init'; model: string; sessionId: string }
  | {
      type: 'copilot:plan';
      entries: Array<{ content: string; priority: string; status: string }>;
    }
  | { type: 'copilot:mode-change'; modeId: string }
  | {
      type: 'copilot:usage';
      used: number;
      size: number;
      cost?: { amount: number; currency: string } | null;
    }
  | { type: 'copilot:session-info'; title?: string | null };

// ---------------------------------------------------------------------------
// Main mapper: CopilotEvent → AgendoEventPayload[]
// ---------------------------------------------------------------------------

export function mapCopilotJsonToEvents(event: CopilotEvent): AgendoEventPayload[] {
  switch (event.type) {
    // -----------------------------------------------------------------------
    // copilot:init → session:init with model (synthetic, emitted by adapter)
    // -----------------------------------------------------------------------
    case 'copilot:init':
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
    // copilot:text → agent:text
    // -----------------------------------------------------------------------
    case 'copilot:text':
      return [{ type: 'agent:text', text: event.text }];

    // -----------------------------------------------------------------------
    // copilot:text-delta → agent:text-delta (streaming chunk)
    // -----------------------------------------------------------------------
    case 'copilot:text-delta':
      return [{ type: 'agent:text-delta', text: event.text }];

    // -----------------------------------------------------------------------
    // copilot:thinking → agent:thinking
    // -----------------------------------------------------------------------
    case 'copilot:thinking':
      return [{ type: 'agent:thinking', text: event.text }];

    // -----------------------------------------------------------------------
    // copilot:thinking-delta → agent:thinking-delta (streaming chunk)
    // -----------------------------------------------------------------------
    case 'copilot:thinking-delta':
      return [{ type: 'agent:thinking-delta', text: event.text }];

    // -----------------------------------------------------------------------
    // copilot:tool-start → agent:tool-start
    // -----------------------------------------------------------------------
    case 'copilot:tool-start':
      return [buildToolStartEvent(event.toolUseId, event.toolName, event.toolInput)];

    // -----------------------------------------------------------------------
    // copilot:tool-end → agent:tool-end
    // -----------------------------------------------------------------------
    case 'copilot:tool-end':
      return [buildToolEndEvent(event.toolUseId, event.resultText ?? '')];

    // -----------------------------------------------------------------------
    // copilot:turn-complete → agent:result
    // -----------------------------------------------------------------------
    case 'copilot:turn-complete': {
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
          copilot: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            costUSD: 0,
          },
        };
      }
      return [result];
    }

    // -----------------------------------------------------------------------
    // copilot:turn-error → agent:result (isError) + system:error
    // -----------------------------------------------------------------------
    case 'copilot:turn-error':
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
          message: `Copilot turn failed: ${event.message}`,
        },
      ];

    // -----------------------------------------------------------------------
    // copilot:plan → agent:plan (Copilot plan mode execution steps)
    // -----------------------------------------------------------------------
    case 'copilot:plan':
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
    // copilot:mode-change → session:mode-change (permission mode updated)
    // -----------------------------------------------------------------------
    case 'copilot:mode-change': {
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
    // copilot:usage → agent:usage (real-time context window stats + optional cost)
    // -----------------------------------------------------------------------
    case 'copilot:usage': {
      const usageEvent: AgendoEventPayload = {
        type: 'agent:usage',
        used: event.used,
        size: event.size,
      };
      if (event.cost?.amount != null) {
        (usageEvent as { costUsd?: number }).costUsd = event.cost.amount;
      }
      return [usageEvent];
    }

    // -----------------------------------------------------------------------
    // copilot:session-info → session:info (auto-title, metadata updates)
    // -----------------------------------------------------------------------
    case 'copilot:session-info':
      return [{ type: 'session:info', title: event.title ?? null }];

    default:
      return [];
  }
}
