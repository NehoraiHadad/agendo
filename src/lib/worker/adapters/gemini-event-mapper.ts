import type { AgendoEventPayload } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Gemini synthetic NDJSON event types
// ---------------------------------------------------------------------------
// These are emitted by gemini-adapter.ts as JSON lines so that
// session-process.ts can parse them through the standard NDJSON pipeline
// and delegate to mapJsonToEvents (this file).
// ---------------------------------------------------------------------------

export type GeminiEvent =
  | { type: 'gemini:text'; text: string }
  | { type: 'gemini:thinking'; text: string }
  | {
      type: 'gemini:tool-start';
      toolName: string;
      toolInput: Record<string, unknown>;
      toolUseId: string;
    }
  | { type: 'gemini:tool-end'; toolUseId: string }
  | { type: 'gemini:turn-complete'; result: Record<string, unknown> }
  | { type: 'gemini:turn-error'; message: string }
  | { type: 'gemini:retry'; message: string };

// ---------------------------------------------------------------------------
// Main mapper: GeminiEvent → AgendoEventPayload[]
// ---------------------------------------------------------------------------

export function mapGeminiJsonToEvents(event: GeminiEvent): AgendoEventPayload[] {
  switch (event.type) {
    // -----------------------------------------------------------------------
    // gemini:text → agent:text
    // -----------------------------------------------------------------------
    case 'gemini:text':
      return [{ type: 'agent:text', text: event.text }];

    // -----------------------------------------------------------------------
    // gemini:thinking → agent:thinking
    // -----------------------------------------------------------------------
    case 'gemini:thinking':
      return [{ type: 'agent:thinking', text: event.text }];

    // -----------------------------------------------------------------------
    // gemini:tool-start → agent:tool-start
    // -----------------------------------------------------------------------
    case 'gemini:tool-start':
      return [
        {
          type: 'agent:tool-start',
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.toolInput,
        },
      ];

    // -----------------------------------------------------------------------
    // gemini:tool-end → agent:tool-end
    // -----------------------------------------------------------------------
    case 'gemini:tool-end':
      return [
        {
          type: 'agent:tool-end',
          toolUseId: event.toolUseId,
          content: '',
        },
      ];

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
    // gemini:retry → system:info (informational — user sees retry message)
    // -----------------------------------------------------------------------
    case 'gemini:retry':
      return [{ type: 'system:info', message: event.message }];

    default:
      return [];
  }
}
