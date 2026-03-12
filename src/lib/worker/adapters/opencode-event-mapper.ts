import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

// ---------------------------------------------------------------------------
// OpenCode synthetic NDJSON event types
// ---------------------------------------------------------------------------
// These are emitted by opencode-adapter.ts as JSON lines so that
// session-process.ts can parse them through the standard NDJSON pipeline
// and delegate to mapJsonToEvents (this file).
//
// Note: no opencode:commands — OpenCode uses agents, not slash commands.
// ---------------------------------------------------------------------------

export type OpenCodeEvent =
  | { type: 'opencode:text'; text: string }
  | { type: 'opencode:text-delta'; text: string }
  | { type: 'opencode:thinking'; text: string }
  | { type: 'opencode:thinking-delta'; text: string }
  | {
      type: 'opencode:tool-start';
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId: string;
    }
  | { type: 'opencode:tool-end'; toolUseId: string; resultText?: string; failed?: boolean }
  | { type: 'opencode:turn-complete'; result: Record<string, unknown> }
  | { type: 'opencode:turn-error'; message: string }
  | { type: 'opencode:init'; model: string; sessionId: string }
  | {
      type: 'opencode:plan';
      entries: Array<{ content: string; priority: string; status: string }>;
    }
  | { type: 'opencode:mode-change'; modeId: string }
  | { type: 'opencode:usage'; used: number; size: number };

// ---------------------------------------------------------------------------
// Main mapper: OpenCodeEvent → AgendoEventPayload[]
// ---------------------------------------------------------------------------

export function mapOpenCodeJsonToEvents(event: OpenCodeEvent): AgendoEventPayload[] {
  switch (event.type) {
    // -----------------------------------------------------------------------
    // opencode:init → session:init with model (synthetic, emitted by adapter)
    // -----------------------------------------------------------------------
    case 'opencode:init':
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
    // opencode:text → agent:text
    // -----------------------------------------------------------------------
    case 'opencode:text':
      return [{ type: 'agent:text', text: event.text }];

    // -----------------------------------------------------------------------
    // opencode:text-delta → agent:text-delta (streaming chunk)
    // -----------------------------------------------------------------------
    case 'opencode:text-delta':
      return [{ type: 'agent:text-delta', text: event.text }];

    // -----------------------------------------------------------------------
    // opencode:thinking → agent:thinking
    // -----------------------------------------------------------------------
    case 'opencode:thinking':
      return [{ type: 'agent:thinking', text: event.text }];

    // -----------------------------------------------------------------------
    // opencode:thinking-delta → agent:thinking-delta (streaming chunk)
    // -----------------------------------------------------------------------
    case 'opencode:thinking-delta':
      return [{ type: 'agent:thinking-delta', text: event.text }];

    // -----------------------------------------------------------------------
    // opencode:tool-start → agent:tool-start
    // -----------------------------------------------------------------------
    case 'opencode:tool-start':
      return [buildToolStartEvent(event.toolUseId, event.toolName, event.toolInput)];

    // -----------------------------------------------------------------------
    // opencode:tool-end → agent:tool-end
    // -----------------------------------------------------------------------
    case 'opencode:tool-end':
      return [buildToolEndEvent(event.toolUseId, event.resultText ?? '')];

    // -----------------------------------------------------------------------
    // opencode:turn-complete → agent:result
    // -----------------------------------------------------------------------
    case 'opencode:turn-complete': {
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
          opencode: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            costUSD: 0,
          },
        };
      }
      return [result];
    }

    // -----------------------------------------------------------------------
    // opencode:turn-error → agent:result (isError) + system:error
    // -----------------------------------------------------------------------
    case 'opencode:turn-error':
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
          message: `OpenCode turn failed: ${event.message}`,
        },
      ];

    // -----------------------------------------------------------------------
    // opencode:plan → agent:plan (TodoWrite tool update)
    // -----------------------------------------------------------------------
    case 'opencode:plan':
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
    // opencode:mode-change → session:mode-change (agent mode updated)
    // OpenCode agent names: plan, build, general, explore
    // -----------------------------------------------------------------------
    case 'opencode:mode-change': {
      const modeMap: Record<string, string> = {
        general: 'default',
        plan: 'plan',
      };
      const mode = modeMap[event.modeId] ?? event.modeId;
      return [{ type: 'session:mode-change', mode }];
    }

    // -----------------------------------------------------------------------
    // opencode:usage → agent:usage (real-time context window stats)
    // -----------------------------------------------------------------------
    case 'opencode:usage':
      return [{ type: 'agent:usage', used: event.used, size: event.size }];

    default:
      return [];
  }
}
