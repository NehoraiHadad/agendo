/**
 * Codex JSONL file reader — reads Codex session files from disk and maps them
 * to AgendoEventPayload[] for post-restart history recovery.
 *
 * Pattern mirrors claude-history.ts: read the CLI's native session file directly
 * instead of requiring a running process (thread/read RPC).
 *
 * Codex writes JSONL files at:
 *   ~/.codex/sessions/{yyyy}/{mm}/{dd}/rollout-{timestamp}-{sessionId}.jsonl
 *
 * Each line is `{ timestamp, type, payload }` with types:
 *   - session_meta — session metadata (id, cwd, model, cli_version)
 *   - response_item — API response items (message, function_call, function_call_output, reasoning)
 *   - event_msg — processed events (user_message, agent_message, agent_reasoning,
 *     exec_command_end, patch_apply_end, mcp_tool_call_end, task_complete, token_count)
 *   - turn_context — per-turn metadata (model, approval_policy, sandbox_policy)
 *
 * Limitations vs the Agendo log file:
 * - No cost/token data (Codex doesn't expose cost)
 * - No approval history, team events, or Agendo-specific events
 * - No streaming deltas (only completed items)
 *
 * This gives ~65% fidelity — enough for a usable reconnect experience.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

// ---------------------------------------------------------------------------
// Types for Codex JSONL records
// ---------------------------------------------------------------------------

interface CodexJsonlRecord {
  timestamp: string;
  type: 'session_meta' | 'response_item' | 'event_msg' | 'turn_context';
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// File location helpers
// ---------------------------------------------------------------------------

/**
 * Find the Codex JSONL file for a given session ID by scanning the sessions
 * directory. Files are named: rollout-{timestamp}-{sessionId}.jsonl
 *
 * Scans the last 7 days of date directories to find the file.
 * Returns the full path or null if not found.
 */
export function findCodexSessionFile(sessionRef: string): string | null {
  if (!sessionRef) return null;

  const sessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return null;

  // Scan recent date directories (last 7 days)
  const now = new Date();
  for (let daysBack = 0; daysBack < 7; daysBack++) {
    const d = new Date(now);
    d.setDate(d.getDate() - daysBack);
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dayDir = join(sessionsDir, yyyy, mm, dd);

    if (!existsSync(dayDir)) continue;

    try {
      const files = readdirSync(dayDir);
      const match = files.find((f) => f.endsWith(`-${sessionRef}.jsonl`));
      if (match) return join(dayDir, match);
    } catch {
      // Skip unreadable directories
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API: read + map
// ---------------------------------------------------------------------------

/**
 * Read a Codex session's JSONL file and return AgendoEventPayload[].
 * Falls back gracefully: returns empty array if file not found or unreadable.
 *
 * @param sessionRef - The Codex thread/session ID (UUID embedded in filename)
 * @returns AgendoEventPayload[] — mapped events, or empty array on failure
 */
export function readCodexSessionFile(sessionRef: string): AgendoEventPayload[] {
  if (!sessionRef) return [];

  const filePath = findCodexSessionFile(sessionRef);
  if (!filePath) return [];

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return mapCodexJsonlToEvents(raw);
}

/**
 * Parse raw JSONL content and map to AgendoEventPayload[].
 * Exported for testing — production code should use readCodexSessionFile().
 */
export function mapCodexJsonlToEvents(content: string): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];
  let firstTurnContextSeen = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: CodexJsonlRecord;
    try {
      record = JSON.parse(trimmed) as CodexJsonlRecord;
    } catch {
      // Skip malformed lines
      continue;
    }

    if (!record.type || !record.payload) continue;

    const mapped = mapRecord(record, firstTurnContextSeen);
    if (record.type === 'turn_context' && !firstTurnContextSeen) {
      firstTurnContextSeen = true;
    }
    events.push(...mapped);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Record mapping
// ---------------------------------------------------------------------------

function mapRecord(record: CodexJsonlRecord, firstTurnContextSeen: boolean): AgendoEventPayload[] {
  switch (record.type) {
    case 'event_msg':
      return mapEventMsg(record.payload);
    case 'response_item':
      return mapResponseItem(record.payload);
    case 'turn_context':
      return mapTurnContext(record.payload, firstTurnContextSeen);
    case 'session_meta':
      // No meaningful event mapping — metadata only
      return [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// event_msg mapping
// ---------------------------------------------------------------------------

function mapEventMsg(payload: Record<string, unknown>): AgendoEventPayload[] {
  const payloadType = payload.type as string;
  if (!payloadType) return [];

  switch (payloadType) {
    case 'user_message': {
      const message = payload.message as string;
      if (!message) return [];
      return [{ type: 'user:message', text: message }];
    }

    case 'agent_message': {
      const message = payload.message as string;
      if (!message) return [];
      return [{ type: 'agent:text', text: message }];
    }

    case 'agent_reasoning': {
      const text = payload.text as string;
      if (!text) return [];
      return [{ type: 'agent:thinking', text }];
    }

    case 'exec_command_end': {
      const callId = (payload.call_id as string) || `cmd-${payload.process_id ?? 'unknown'}`;
      const command = payload.command as string[] | undefined;
      const cmdStr = command ? command.join(' ') : '';
      const cwd = (payload.cwd as string) || '';
      const exitCode = (payload.exit_code as number) ?? 0;
      const output = (payload.aggregated_output as string) || '';
      const content = exitCode !== 0 ? `[exit ${exitCode}] ${output}` : output;

      return [
        buildToolStartEvent(callId, 'Bash', { command: cmdStr, cwd }),
        buildToolEndEvent(callId, content),
      ];
    }

    case 'patch_apply_end': {
      const callId = (payload.call_id as string) || 'patch-unknown';
      const path = (payload.path as string) || '';
      const kind = (payload.kind as string) || 'modify';
      return [
        buildToolStartEvent(callId, 'FileChange', { path, kind }),
        buildToolEndEvent(callId, `${kind}: ${path}`),
      ];
    }

    case 'mcp_tool_call_end': {
      const callId = (payload.call_id as string) || 'mcp-unknown';
      const server = (payload.server as string) || '';
      const tool = (payload.tool as string) || 'MCP';
      const args = (payload.arguments as Record<string, unknown>) || {};
      const result = (payload.result as string) || (payload.output as string) || '';
      const error = payload.error as { message: string } | null;

      return [
        buildToolStartEvent(callId, tool || 'MCP', { server, tool, arguments: args }),
        buildToolEndEvent(callId, error?.message ?? result),
      ];
    }

    case 'task_complete':
      return [
        {
          type: 'agent:result',
          costUsd: null,
          turns: 1,
          durationMs: null,
        },
      ];

    case 'task_started':
    case 'token_count':
      // No meaningful event mapping
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// response_item mapping
// ---------------------------------------------------------------------------

function mapResponseItem(payload: Record<string, unknown>): AgendoEventPayload[] {
  const payloadType = payload.type as string;
  if (!payloadType) return [];

  switch (payloadType) {
    case 'message': {
      const role = payload.role as string;
      // Skip developer/system messages — only map assistant messages
      if (role !== 'assistant') return [];

      const content = payload.content as Array<{ type: string; text?: string }> | undefined;
      if (!content || !Array.isArray(content)) return [];

      const text = content
        .filter((c) => (c.type === 'output_text' || c.type === 'text') && c.text)
        .map((c) => c.text as string)
        .join('\n');
      if (!text) return [];
      return [{ type: 'agent:text', text }];
    }

    case 'reasoning': {
      const summary = payload.summary as Array<{ type: string; text?: string }> | undefined;
      if (!summary || !Array.isArray(summary)) return [];
      const text = summary
        .filter((s) => s.text)
        .map((s) => s.text as string)
        .join('\n');
      if (!text) return [];
      return [{ type: 'agent:thinking', text }];
    }

    case 'function_call':
    case 'function_call_output':
      // These are the raw API request/response items — the processed versions
      // come through as event_msg/exec_command_end etc. Skip to avoid duplicates.
      return [];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// turn_context mapping
// ---------------------------------------------------------------------------

function mapTurnContext(
  payload: Record<string, unknown>,
  firstTurnContextSeen: boolean,
): AgendoEventPayload[] {
  // Only emit session:init for the first turn_context (session start)
  if (firstTurnContextSeen) return [];

  const model = payload.model as string | undefined;
  if (!model) return [];

  return [
    {
      type: 'session:init',
      sessionRef: (payload.turn_id as string) || '',
      slashCommands: [],
      mcpServers: [],
      model,
    },
  ];
}
