import type { AgendoEventPayload } from '@/lib/realtime/events';
import { createAcpEventMapper, ACP_MODE_MAP } from './acp-event-mapper';

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

const mapAcp = createAcpEventMapper({ agentLabel: 'Copilot', modeMap: ACP_MODE_MAP });

export function mapCopilotJsonToEvents(event: CopilotEvent): AgendoEventPayload[] {
  return mapAcp(event);
}
