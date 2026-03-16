/**
 * Codex history mapper — converts thread/read response to AgendoEventPayload[].
 *
 * Used as a fallback when the Agendo session log file is missing/empty.
 * Codex's thread/read returns a Thread with Turn[] containing ThreadItem[].
 * Items are already the same types that live notifications use, so we reuse
 * normalizeThreadItem() from codex-app-server-event-mapper.ts.
 *
 * Limitations vs the Agendo log file:
 * - No cost/token data (Codex doesn't expose cost anywhere)
 * - No approval history, team events, or Agendo-specific events
 * - Requires a running codex app-server process
 *
 * This gives ~65% fidelity — enough for a usable reconnect experience.
 */

import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';
import {
  normalizeThreadItem,
  type AppServerAgentMessageItem,
  type AppServerReasoningItem,
  type AppServerCommandExecutionItem,
  type AppServerFileChangeItem,
  type AppServerMcpToolCallItem,
  type AppServerPlanItem,
} from './codex-app-server-event-mapper';

// ---------------------------------------------------------------------------
// Types matching the thread/read response shape
// ---------------------------------------------------------------------------

interface Thread {
  id: string;
  cwd: string;
  turns: Turn[];
}

interface Turn {
  id: string;
  items: Array<Record<string, unknown>>;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string } | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Map a Codex Thread (from thread/read) to AgendoEventPayload[].
 * The output can be used directly by worker-sse.ts to send catchup events
 * to a reconnecting browser.
 */
export function mapCodexThreadToEvents(thread: unknown): AgendoEventPayload[] {
  const t = thread as Thread;
  const events: AgendoEventPayload[] = [];

  for (const turn of t.turns) {
    for (const rawItem of turn.items) {
      // Handle userMessage directly (not covered by normalizeThreadItem)
      if (rawItem.type === 'userMessage') {
        events.push(...mapUserMessageItem(rawItem));
        continue;
      }

      const item = normalizeThreadItem(rawItem);
      if (!item) continue;

      events.push(...mapThreadItemToEvents(item));
    }

    // Emit agent:result at the end of each completed/failed turn
    if (turn.status === 'completed' || turn.status === 'failed' || turn.status === 'interrupted') {
      events.push({
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        ...(turn.status === 'failed'
          ? {
              isError: true,
              errors: turn.error ? [turn.error.message] : ['Turn failed'],
            }
          : {}),
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Per-item mapping (reuses normalizeThreadItem for type-safe access)
// ---------------------------------------------------------------------------

function mapThreadItemToEvents(item: ReturnType<typeof normalizeThreadItem>): AgendoEventPayload[] {
  if (!item) return [];

  switch (item.type) {
    case 'agentMessage': {
      const msg = item as AppServerAgentMessageItem;
      if (!msg.text) return [];
      return [{ type: 'agent:text', text: msg.text }];
    }

    case 'reasoning': {
      const reasoning = item as AppServerReasoningItem;
      const text = reasoning.summary.join('\n') || reasoning.content.join('\n');
      if (!text) return [];
      return [{ type: 'agent:thinking', text }];
    }

    case 'commandExecution': {
      const cmd = item as AppServerCommandExecutionItem;
      const events: AgendoEventPayload[] = [];
      events.push(buildToolStartEvent(cmd.id, 'Bash', { command: cmd.command, cwd: cmd.cwd }));
      const exitCode = cmd.exitCode ?? 0;
      const output = cmd.aggregatedOutput ?? '';
      const content = exitCode !== 0 ? `[exit ${exitCode}] ${output}` : output;
      events.push(buildToolEndEvent(cmd.id, content));
      return events;
    }

    case 'fileChange': {
      const fc = item as AppServerFileChangeItem;
      const events: AgendoEventPayload[] = [];
      events.push(buildToolStartEvent(fc.id, 'FileChange', { changes: fc.changes }));
      const content = fc.changes.map((c) => `${c.kind}: ${c.path}`).join('\n');
      events.push(buildToolEndEvent(fc.id, content));
      return events;
    }

    case 'mcpToolCall': {
      const mcp = item as AppServerMcpToolCallItem;
      const events: AgendoEventPayload[] = [];
      events.push(
        buildToolStartEvent(mcp.id, mcp.tool || 'MCP', {
          server: mcp.server,
          tool: mcp.tool,
          arguments: mcp.arguments,
        }),
      );
      const content = mcp.result?.output ?? mcp.error?.message ?? '';
      events.push(buildToolEndEvent(mcp.id, content));
      return events;
    }

    case 'plan': {
      const plan = item as AppServerPlanItem;
      if (!plan.text) return [];
      return [{ type: 'agent:text', text: plan.text }];
    }

    case 'contextCompaction':
      return [
        { type: 'system:compact-start', trigger: 'auto' },
        { type: 'system:info', message: 'Conversation history compacted' },
      ];

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// userMessage mapping (not covered by normalizeThreadItem)
// ---------------------------------------------------------------------------

function mapUserMessageItem(rawItem: Record<string, unknown>): AgendoEventPayload[] {
  const content = rawItem.content as Array<{ type: string; text?: string }> | undefined;
  if (!content) return [];
  const text = content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text as string)
    .join('\n');
  if (!text) return [];
  return [{ type: 'user:message', text }];
}
