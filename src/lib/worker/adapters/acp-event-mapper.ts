import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

// ---------------------------------------------------------------------------
// Shared ACP event mapper factory
// ---------------------------------------------------------------------------
// Gemini, Copilot, and OpenCode adapters all emit structurally identical
// synthetic NDJSON events differing only in their prefix (gemini:*, copilot:*,
// opencode:*).  This factory eliminates the duplicated switch/case logic.
// ---------------------------------------------------------------------------

/**
 * Base event shape shared by all ACP agents.  Each agent's specific type union
 * (GeminiEvent, CopilotEvent, OpenCodeEvent) is a structural subtype of this.
 */
export type AcpBaseEvent =
  | { type: string; text: string }
  | { type: string; toolName: string; toolInput: Record<string, unknown>; toolUseId: string }
  | { type: string; toolUseId: string; resultText?: string; failed?: boolean }
  | { type: string; result: Record<string, unknown> }
  | { type: string; message: string }
  | { type: string; model: string; sessionId: string }
  | { type: string; entries: Array<{ content: string; priority: string; status: string }> }
  | { type: string; modeId: string }
  | { type: string; used: number; size: number; cost?: { amount: number; currency: string } | null }
  | { type: string; commands: Array<{ name: string; description: string; argumentHint: string }> }
  | { type: string; title?: string | null };

/** Configuration for an ACP event mapper instance. */
export interface AcpMapperConfig {
  /** Human-readable agent label, used in error messages and modelUsage keys. */
  agentLabel: string;
  /** Maps ACP mode IDs → Agendo permission mode names. */
  modeMap: Record<string, string>;
}

/**
 * Create a mapper function that converts prefixed ACP events into
 * AgendoEventPayload arrays.
 *
 * The mapper strips the `<prefix>:` from event.type and dispatches
 * against the shared base types (init, text, tool-start, …).
 */
export function createAcpEventMapper(config: AcpMapperConfig) {
  const { agentLabel, modeMap } = config;

  return function mapAcpEvent(event: AcpBaseEvent): AgendoEventPayload[] {
    // Strip prefix: "gemini:text" → "text", "copilot:tool-start" → "tool-start"
    const baseType = event.type.replace(/^[^:]+:/, '');

    switch (baseType) {
      // -------------------------------------------------------------------
      // init → session:init
      // -------------------------------------------------------------------
      case 'init': {
        const e = event as { type: string; model: string; sessionId: string };
        return [
          {
            type: 'session:init',
            sessionRef: e.sessionId,
            slashCommands: [],
            mcpServers: [],
            model: e.model,
          },
        ];
      }

      // -------------------------------------------------------------------
      // text / text-delta / thinking / thinking-delta
      // -------------------------------------------------------------------
      case 'text':
        return [{ type: 'agent:text', text: (event as { type: string; text: string }).text }];

      case 'text-delta':
        return [{ type: 'agent:text-delta', text: (event as { type: string; text: string }).text }];

      case 'thinking':
        return [{ type: 'agent:thinking', text: (event as { type: string; text: string }).text }];

      case 'thinking-delta':
        return [
          { type: 'agent:thinking-delta', text: (event as { type: string; text: string }).text },
        ];

      // -------------------------------------------------------------------
      // tool-start / tool-end
      // -------------------------------------------------------------------
      case 'tool-start': {
        const e = event as {
          type: string;
          toolUseId: string;
          toolName: string;
          toolInput: Record<string, unknown>;
        };
        return [buildToolStartEvent(e.toolUseId, e.toolName, e.toolInput)];
      }

      case 'tool-end': {
        const e = event as { type: string; toolUseId: string; resultText?: string };
        return [buildToolEndEvent(e.toolUseId, e.resultText ?? '')];
      }

      // -------------------------------------------------------------------
      // turn-complete → agent:result (with optional usage extraction)
      // -------------------------------------------------------------------
      case 'turn-complete': {
        const e = event as {
          type: string;
          result: { usage?: { inputTokens?: number; outputTokens?: number } };
        };
        const result: AgendoEventPayload = {
          type: 'agent:result',
          costUsd: null,
          turns: 1,
          durationMs: null,
        };

        const usage = e.result?.usage;
        if (usage && (usage.inputTokens || usage.outputTokens)) {
          (result as Record<string, unknown>).modelUsage = {
            [agentLabel.toLowerCase()]: {
              inputTokens: usage.inputTokens ?? 0,
              outputTokens: usage.outputTokens ?? 0,
              costUSD: 0,
            },
          };
        }
        return [result];
      }

      // -------------------------------------------------------------------
      // turn-error → agent:result (isError) + system:error
      // -------------------------------------------------------------------
      case 'turn-error': {
        const e = event as { type: string; message: string };
        return [
          {
            type: 'agent:result',
            costUsd: null,
            turns: 1,
            durationMs: null,
            isError: true,
            errors: [e.message],
          },
          {
            type: 'system:error',
            message: `${agentLabel} turn failed: ${e.message}`,
          },
        ];
      }

      // -------------------------------------------------------------------
      // plan → agent:plan
      // -------------------------------------------------------------------
      case 'plan': {
        const e = event as {
          type: string;
          entries: Array<{ content: string; priority: string; status: string }>;
        };
        return [
          {
            type: 'agent:plan',
            entries: e.entries.map((entry) => ({
              content: entry.content,
              priority: entry.priority as 'high' | 'medium' | 'low',
              status: entry.status as 'pending' | 'in_progress' | 'completed',
            })),
          },
        ];
      }

      // -------------------------------------------------------------------
      // mode-change → session:mode-change
      // -------------------------------------------------------------------
      case 'mode-change': {
        const modeId = (event as { type: string; modeId: string }).modeId;
        const mode = modeMap[modeId] ?? modeId;
        return [{ type: 'session:mode-change', mode }];
      }

      // -------------------------------------------------------------------
      // usage → agent:usage (with optional cost)
      // -------------------------------------------------------------------
      case 'usage': {
        const e = event as {
          type: string;
          used: number;
          size: number;
          cost?: { amount: number; currency: string } | null;
        };
        const usageEvent: AgendoEventPayload = {
          type: 'agent:usage',
          used: e.used,
          size: e.size,
        };
        if (e.cost?.amount != null) {
          (usageEvent as { costUsd?: number }).costUsd = e.cost.amount;
        }
        return [usageEvent];
      }

      // -------------------------------------------------------------------
      // session-info → session:info
      // -------------------------------------------------------------------
      case 'session-info':
        return [
          {
            type: 'session:info',
            title: (event as { type: string; title?: string | null }).title ?? null,
          },
        ];

      // -------------------------------------------------------------------
      // commands → session:commands (Gemini-specific)
      // -------------------------------------------------------------------
      case 'commands': {
        const e = event as {
          type: string;
          commands: Array<{ name: string; description: string; argumentHint: string }>;
        };
        return [{ type: 'session:commands', slashCommands: e.commands }];
      }

      default:
        return [];
    }
  };
}

// ---------------------------------------------------------------------------
// Shared ACP mode maps
// ---------------------------------------------------------------------------

/** Standard ACP mode map (Gemini, Copilot). */
export const ACP_MODE_MAP: Record<string, string> = {
  default: 'default',
  autoEdit: 'acceptEdits',
  yolo: 'bypassPermissions',
  plan: 'plan',
};

/** OpenCode mode map (uses 'general' instead of 'default'). */
export const OPENCODE_MODE_MAP: Record<string, string> = {
  general: 'default',
  plan: 'plan',
};
