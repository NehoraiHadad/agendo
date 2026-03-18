import type { AgendoEvent } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolCallResult {
  content: string;
  isError: boolean;
}

export interface SubagentInfo {
  agentId: string;
  description?: string;
  subagentType?: string;
}

export interface ToolState {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  result?: ToolCallResult;
  durationMs?: number;
  numFiles?: number;
  truncated?: boolean;
  /** Present when this tool call spawned a subagent (Task / Agent tools). */
  subagentInfo?: SubagentInfo;
}

export type AssistantPart =
  | { kind: 'text'; text: string; fromDelta?: boolean }
  | { kind: 'tool'; tool: ToolState };

/** Metadata from agent:result, attached to the last assistant bubble of the turn. */
export interface TurnMeta {
  costUsd: number | null;
  sessionCostUsd: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  turns: number | null;
  webSearches: number;
  denials: number;
}

export type DisplayItem =
  | { kind: 'assistant'; id: number; ts?: number; parts: AssistantPart[]; turnMeta?: TurnMeta }
  | {
      kind: 'turn-complete';
      id: number;
      ts?: number;
      text: string;
      costUsd: number | null;
      sessionCostUsd: number | null;
      isError?: boolean;
      errors?: string[];
    }
  | { kind: 'thinking'; id: number; text: string }
  | {
      kind: 'user';
      id: number;
      ts?: number;
      text: string;
      hasImage?: boolean;
      imageDataUrl?: string;
      /**
       * UUID of the preceding assistant turn — used as --resume-session-at when branching.
       * null = first user message (no preceding turn); fork without --resume-session-at.
       * undefined = branch button not applicable (non-session context).
       */
      branchUuid?: string | null;
    }
  | { kind: 'info'; id: number; text: string }
  | { kind: 'compact-loading'; id: number; trigger: 'auto' | 'manual' }
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

/**
 * Claude Code internal protocol XML tags that leak into assistant text.
 * These come from slash commands (/exit, /help, etc.) and team protocol
 * messages and should be stripped from the chat UI while remaining in raw
 * event logs for debugging.
 *
 * Known tags:
 *   <local-command-stdout>...</local-command-stdout>
 *   <local-command-stderr>...</local-command-stderr>
 *   <command-name>...</command-name>
 *   <command-message>...</command-message>
 *   <command-args>...</command-args>
 *   <command-result>...</command-result>
 *   <teammate-message teammate_id="..." color="...">...</teammate-message>
 *
 * local-command-stderr content is extracted and surfaced as an error pill
 * so the user sees command failures without the raw XML noise.
 * teammate-message events are already handled by the Team Panel (useTeamState).
 */
const PROTOCOL_XML_TAG_NAMES = [
  'local-command-stdout',
  'local-command-stderr',
  'command-name',
  'command-message',
  'command-args',
  'command-result',
  'teammate-message',
];
// Match complete <tag>content</tag> pairs (content may be empty or multi-line)
const PROTOCOL_XML_PAIR_RE = new RegExp(
  `<(${PROTOCOL_XML_TAG_NAMES.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  'g',
);
// Extract content from <local-command-stderr>...</local-command-stderr>
const STDERR_EXTRACT_RE = /<local-command-stderr\b[^>]*>([\s\S]*?)<\/local-command-stderr>/g;

interface ProtocolXmlResult {
  /** Cleaned text with all protocol XML removed (may be empty). */
  cleanText: string;
  /** Extracted stderr messages from local-command-stderr tags. */
  stderrMessages: string[];
}

/** Strip Claude Code internal protocol XML from text, extracting stderr for display. */
function stripProtocolXml(text: string): ProtocolXmlResult {
  if (!text.includes('<')) return { cleanText: text, stderrMessages: [] };
  const hasProtocol = PROTOCOL_XML_TAG_NAMES.some((tag) => text.includes(`<${tag}`));
  if (!hasProtocol) return { cleanText: text, stderrMessages: [] };

  // Extract stderr content before stripping
  const stderrMessages: string[] = [];
  for (const match of text.matchAll(STDERR_EXTRACT_RE)) {
    const content = match[1].trim();
    if (content) stderrMessages.push(content);
  }

  // Strip all protocol XML pairs
  const stripped = text.replace(PROTOCOL_XML_PAIR_RE, '');
  // Clean up leftover "//" separators between stripped blocks (only on own line, not URLs)
  const cleanText = stripped.replace(/^\s*\/\/\s*$/gm, '').trim();

  return { cleanText, stderrMessages };
}

/** Map a Claude result error subtype to a human-readable label. */
function errorSubtypeLabel(subtype?: string): string {
  switch (subtype) {
    case 'error_max_turns':
      return 'Max turns reached';
    case 'error_during_execution':
      return 'Error during execution';
    case 'error_max_budget_usd':
      return 'Budget exceeded';
    default:
      return subtype ? `Error: ${subtype}` : 'Error';
  }
}

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
  // Pre-pass: collect subagent info keyed by the Task/Agent toolUseId.
  // subagent:start is emitted on agent:tool-end (after the subagent completes),
  // so it always exists before or after the tool-start in the events array.
  const subagentByToolUseId = new Map<string, SubagentInfo>();
  for (const ev of events) {
    if (ev.type === 'subagent:start') {
      subagentByToolUseId.set(ev.toolUseId, {
        agentId: ev.agentId,
        description: ev.description,
        subagentType: ev.subagentType,
      });
    }
  }

  // Track pending tool calls so we can hydrate them with results as they arrive
  const pendingTools = new Map<string, ToolState>();
  // Dedup team messages — backfill on cold-resume re-emits all inbox messages
  const seenTeamMessages = new Set<string>();
  let sessionInitCount = 0;
  let sessionCostUsd = 0;
  // Track the last assistant UUID from agent:result so the next user:message
  // can offer a branch button (Claude only — only set when messageUuid is present).
  let lastAgentResultUuid: string | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case 'agent:text': {
        // Strip Claude Code internal protocol XML (slash command output, /exit, etc.)
        // stderr content is extracted and surfaced as error pills.
        const { cleanText, stderrMessages } = stripProtocolXml(ev.text);

        // Surface any stderr as error pills so command failures are visible
        for (const stderr of stderrMessages) {
          items.push({ kind: 'error', id: ev.id, text: stderr });
        }

        if (!cleanText) break; // pure protocol noise — skip text bubble

        const last = items[items.length - 1];
        if (last && last.kind === 'assistant') {
          const lastPart = last.parts[last.parts.length - 1];
          if (lastPart && lastPart.kind === 'text' && lastPart.fromDelta) {
            // Replace the delta-accumulated text with the complete text.
            lastPart.text = cleanText;
            lastPart.fromDelta = false;
          } else if (lastPart && lastPart.kind === 'text') {
            // Append to existing non-delta text (consecutive assistant messages)
            lastPart.text += cleanText;
          } else {
            last.parts.push({ kind: 'text', text: cleanText });
          }
        } else {
          items.push({
            kind: 'assistant',
            id: ev.id,
            ts: ev.ts,
            parts: [{ kind: 'text', text: cleanText }],
          });
        }
        break;
      }

      case 'agent:text-delta': {
        // Streaming delta — accumulate into the current assistant text bubble.
        // Mark with fromDelta so the subsequent agent:text can replace (not append).
        const lastD = items[items.length - 1];
        if (lastD && lastD.kind === 'assistant') {
          const lastPartD = lastD.parts[lastD.parts.length - 1];
          if (lastPartD && lastPartD.kind === 'text' && lastPartD.fromDelta) {
            lastPartD.text += ev.text;
          } else {
            lastD.parts.push({ kind: 'text', text: ev.text, fromDelta: true });
          }
        } else {
          items.push({
            kind: 'assistant',
            id: ev.id,
            parts: [{ kind: 'text', text: ev.text, fromDelta: true }],
          });
        }
        break;
      }

      case 'agent:thinking': {
        // If the last item is a thinking bubble (from thinking-delta streaming),
        // replace its text with the complete thinking text instead of creating
        // a duplicate bubble.
        const lastThComplete = items[items.length - 1];
        if (lastThComplete && lastThComplete.kind === 'thinking') {
          lastThComplete.text = ev.text;
        } else {
          items.push({ kind: 'thinking', id: ev.id, text: ev.text });
        }
        break;
      }

      case 'agent:thinking-delta': {
        // Streaming thinking delta — accumulate into the current thinking bubble.
        const lastTh = items[items.length - 1];
        if (lastTh && lastTh.kind === 'thinking') {
          lastTh.text += ev.text;
        } else {
          items.push({ kind: 'thinking', id: ev.id, text: ev.text });
        }
        break;
      }

      case 'agent:tool-start': {
        const result = toolResultMap.get(ev.toolUseId);
        const toolState: ToolState = {
          toolUseId: ev.toolUseId,
          toolName: ev.toolName,
          input: ev.input,
          result,
          subagentInfo: subagentByToolUseId.get(ev.toolUseId),
        };
        pendingTools.set(ev.toolUseId, toolState);

        // Append tool part in order within the current assistant bubble
        const last = items[items.length - 1];
        if (last && last.kind === 'assistant') {
          last.parts.push({ kind: 'tool', tool: toolState });
        } else {
          items.push({
            kind: 'assistant',
            id: ev.id,
            ts: ev.ts,
            parts: [{ kind: 'tool', tool: toolState }],
          });
        }
        break;
      }

      case 'agent:tool-end': {
        const pending = pendingTools.get(ev.toolUseId);
        if (pending) {
          pending.result = { content: extractToolContent(ev.content), isError: false };
          if (ev.durationMs != null) pending.durationMs = ev.durationMs;
          if (ev.numFiles != null) pending.numFiles = ev.numFiles;
          if (ev.truncated != null) pending.truncated = ev.truncated;
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
        const webSearches = ev.serverToolUse?.webSearchRequests ?? 0;
        const denials = ev.permissionDenials?.length ?? 0;
        if (ev.costUsd != null) sessionCostUsd += ev.costUsd;
        // Capture messageUuid for the next user message's branch button.
        lastAgentResultUuid = ev.messageUuid;

        if (ev.isError) {
          // Errors are still shown as a visible pill so the user notices them.
          const label = errorSubtypeLabel(ev.subtype);
          const parts: string[] = [label];
          if (ev.turns != null) parts.push(`${ev.turns} turn${ev.turns !== 1 ? 's' : ''}`);
          if (ev.durationMs != null) parts.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
          if (ev.costUsd != null) parts.push(`$${ev.costUsd.toFixed(4)}`);
          items.push({
            kind: 'turn-complete',
            id: ev.id,
            ts: ev.ts,
            text: parts.join(' · '),
            costUsd: ev.costUsd ?? null,
            sessionCostUsd: ev.costUsd != null ? sessionCostUsd : null,
            isError: true,
            errors: ev.errors,
          });
        } else {
          // Non-error: attach metadata to the last assistant bubble (shown on hover).
          const meta: TurnMeta = {
            costUsd: ev.costUsd ?? null,
            sessionCostUsd: ev.costUsd != null ? sessionCostUsd : null,
            durationMs: ev.durationMs ?? null,
            durationApiMs: ev.durationApiMs ?? null,
            turns: ev.turns ?? null,
            webSearches,
            denials,
          };
          // Walk backwards to find the last assistant item and attach turnMeta.
          for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === 'assistant') {
              (items[i] as Extract<DisplayItem, { kind: 'assistant' }>).turnMeta = meta;
              break;
            }
          }
        }
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
        // Skip injected team messages — already shown via team:message cards.
        // session-team-manager.ts pushes these as "[Message from teammate X]:\n..."
        if (ev.text?.startsWith('[Message from teammate ')) break;

        items.push({
          kind: 'user',
          id: ev.id,
          ts: ev.ts,
          text: ev.text,
          hasImage: ev.hasImage,
          // Attach the UUID of the preceding assistant turn. When present,
          // the chat view shows a branch button on this user message.
          // null = first message (no preceding turn) — still shows button, forks from start.
          branchUuid: lastAgentResultUuid ?? null,
        });
        // Reset: a new user turn starts; next agent:result will set a fresh UUID.
        lastAgentResultUuid = undefined;
        break;
      }

      case 'system:compact-start': {
        items.push({ kind: 'compact-loading', id: ev.id, trigger: ev.trigger });
        break;
      }

      case 'system:info': {
        // Hide internal diagnostic messages from the chat view (still visible in event log)
        if (ev.message.startsWith('History loaded from')) break;

        let infoText = ev.message;
        if (ev.compactMeta) {
          infoText = `Context compacted: ${ev.compactMeta.preTokens.toLocaleString()} tokens → summarized (${ev.compactMeta.trigger})`;
        }
        items.push({ kind: 'info', id: ev.id, text: infoText });
        break;
      }

      case 'system:error': {
        items.push({ kind: 'error', id: ev.id, text: ev.message });
        break;
      }

      case 'team:message': {
        // Dedup: cold-resume backfill re-emits all inbox messages that are
        // already in the log from the previous worker incarnation.
        const dedupKey = `${ev.fromAgent}::${ev.sourceTimestamp}`;
        if (seenTeamMessages.has(dedupKey)) break;
        seenTeamMessages.add(dedupKey);

        // Pushing team-message naturally breaks any open assistant bubble —
        // the next agent:text sees the last item is not 'assistant' and starts fresh.
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

      case 'system:mcp-status': {
        const names = ev.servers.map((s) => `${s.name} (${s.status})`).join(', ');
        items.push({
          kind: 'error',
          id: ev.id,
          text: `MCP server disconnected: ${names}`,
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
