import type { AgendoEventPayload } from '@/lib/realtime/events';
import { createAcpEventMapper, OPENCODE_MODE_MAP } from './acp-event-mapper';

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

const mapAcp = createAcpEventMapper({ agentLabel: 'OpenCode', modeMap: OPENCODE_MODE_MAP });

export function mapOpenCodeJsonToEvents(event: OpenCodeEvent): AgendoEventPayload[] {
  return mapAcp(event);
}
