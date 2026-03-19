import type { AgendoEventPayload } from '@/lib/realtime/events';
import { createAcpEventMapper, ACP_MODE_MAP } from './acp-event-mapper';

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
  | {
      type: 'gemini:usage';
      used: number;
      size: number;
      cost?: { amount: number; currency: string } | null;
    }
  | {
      type: 'gemini:commands';
      commands: Array<{ name: string; description: string; argumentHint: string }>;
    }
  | { type: 'gemini:session-info'; title?: string | null };

// ---------------------------------------------------------------------------
// Main mapper: GeminiEvent → AgendoEventPayload[]
// ---------------------------------------------------------------------------

const mapAcp = createAcpEventMapper({ agentLabel: 'Gemini', modeMap: ACP_MODE_MAP });

export function mapGeminiJsonToEvents(event: GeminiEvent): AgendoEventPayload[] {
  return mapAcp(event);
}
