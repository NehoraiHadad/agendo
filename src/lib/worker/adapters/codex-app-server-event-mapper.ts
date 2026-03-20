import type { AgendoEventPayload } from '@/lib/realtime/events';
import { buildToolStartEvent, buildToolEndEvent } from '@/lib/realtime/event-builders';

// ---------------------------------------------------------------------------
// Synthetic event types emitted by CodexAppServerAdapter to dataCallbacks.
// These use the "as:" prefix to distinguish from old codex exec --json format.
// ---------------------------------------------------------------------------

export type AppServerSyntheticEvent =
  | { type: 'as:thread.started'; threadId: string; model: string }
  | { type: 'as:turn.started' }
  | { type: 'as:item.started'; item: AppServerItem }
  | { type: 'as:item.completed'; item: AppServerItem }
  | { type: 'as:delta'; text: string; itemId: string }
  | { type: 'as:reasoning.delta'; text: string; itemId: string }
  | { type: 'as:cmd-delta'; text: string }
  | { type: 'as:plan-delta'; text: string }
  | { type: 'as:info'; message: string }
  | { type: 'as:compact-start' }
  | { type: 'as:turn.completed'; status: string; error: AppServerTurnError | null }
  | { type: 'as:error'; message: string }
  | {
      type: 'as:skills';
      skills: Array<{ name: string; description: string; shortDescription?: string }>;
    }
  | { type: 'as:usage'; used: number; size: number }
  | { type: 'as:diff-update'; diff: string };

export interface AppServerTurnError {
  message: string;
  additionalDetails?: string | null;
}

// ---------------------------------------------------------------------------
// ThreadItem normalized representation (matches codex app-server v2 types)
// ---------------------------------------------------------------------------

export type AppServerItem =
  | AppServerAgentMessageItem
  | AppServerReasoningItem
  | AppServerCommandExecutionItem
  | AppServerFileChangeItem
  | AppServerMcpToolCallItem
  | AppServerPlanItem
  | { type: string; id: string };

export interface AppServerAgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
}

export interface AppServerReasoningItem {
  type: 'reasoning';
  id: string;
  summary: string[];
  content: string[];
}

export interface AppServerCommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  aggregatedOutput: string | null;
  status: string;
}

export interface AppServerFileChangeItem {
  type: 'fileChange';
  id: string;
  changes: Array<{ path: string; kind: string; newPath?: string | null }>;
  status: string;
}

export interface AppServerMcpToolCallItem {
  type: 'mcpToolCall';
  id: string;
  server: string;
  tool: string;
  arguments: Record<string, unknown>;
  result: { output?: string | null } | null;
  error: { message: string } | null;
  status: string;
}

export interface AppServerPlanItem {
  type: 'plan';
  id: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Tool item types that produce tool-start/tool-end events
// ---------------------------------------------------------------------------

const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall']);

function toolNameForItem(item: AppServerItem): string {
  switch (item.type) {
    case 'commandExecution':
      return 'Bash';
    case 'fileChange':
      return 'FileChange';
    case 'mcpToolCall':
      return (item as AppServerMcpToolCallItem).tool ?? 'MCP';
    default:
      return item.type;
  }
}

function toolInputForItem(item: AppServerItem): Record<string, unknown> {
  switch (item.type) {
    case 'commandExecution': {
      const cmd = item as AppServerCommandExecutionItem;
      return { command: cmd.command, cwd: cmd.cwd };
    }
    case 'fileChange': {
      const fc = item as AppServerFileChangeItem;
      return { changes: fc.changes };
    }
    case 'mcpToolCall': {
      const mcp = item as AppServerMcpToolCallItem;
      return { server: mcp.server, tool: mcp.tool, arguments: mcp.arguments };
    }
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Main mapper: AppServerSyntheticEvent → AgendoEventPayload[]
// ---------------------------------------------------------------------------

export function mapAppServerEventToPayloads(event: AppServerSyntheticEvent): AgendoEventPayload[] {
  switch (event.type) {
    // -----------------------------------------------------------------------
    // thread.started → session:init
    // -----------------------------------------------------------------------
    case 'as:thread.started':
      return [
        {
          type: 'session:init',
          sessionRef: event.threadId,
          slashCommands: [],
          mcpServers: [],
          model: event.model,
        },
      ];

    // -----------------------------------------------------------------------
    // turn.started → [] (thinking state managed by adapter directly)
    // -----------------------------------------------------------------------
    case 'as:turn.started':
      return [];

    // -----------------------------------------------------------------------
    // item.started → agent:tool-start for tool types
    // -----------------------------------------------------------------------
    case 'as:item.started': {
      const { item } = event;
      if (!TOOL_ITEM_TYPES.has(item.type)) return [];
      return [buildToolStartEvent(item.id, toolNameForItem(item), toolInputForItem(item))];
    }

    // -----------------------------------------------------------------------
    // item.completed → varies by item type
    // -----------------------------------------------------------------------
    case 'as:item.completed': {
      const { item } = event;

      if (item.type === 'agentMessage') {
        const msg = item as AppServerAgentMessageItem;
        if (!msg.text) return [];
        return [{ type: 'agent:text', text: msg.text }];
      }

      if (item.type === 'reasoning') {
        const reasoning = item as AppServerReasoningItem;
        // Prefer summary (the concise version for display)
        const text = reasoning.summary.join('\n') || reasoning.content.join('\n');
        if (!text) return [];
        return [{ type: 'agent:thinking', text }];
      }

      if (item.type === 'commandExecution') {
        const cmd = item as AppServerCommandExecutionItem;
        const exitCode = cmd.exitCode ?? 0;
        const output = cmd.aggregatedOutput ?? '';
        const content = exitCode !== 0 ? `[exit ${exitCode}] ${output}` : output;
        return [buildToolEndEvent(cmd.id, content)];
      }

      if (item.type === 'fileChange') {
        const fc = item as AppServerFileChangeItem;
        const content = fc.changes.map((c) => `${c.kind}: ${c.path}`).join('\n');
        return [buildToolEndEvent(fc.id, content)];
      }

      if (item.type === 'mcpToolCall') {
        const mcp = item as AppServerMcpToolCallItem;
        const content = mcp.result?.output ?? mcp.error?.message ?? '';
        return [buildToolEndEvent(mcp.id, content)];
      }

      if (item.type === 'plan') {
        // Plan items are shown as assistant text so they're visible in the chat.
        const plan = item as AppServerPlanItem;
        if (!plan.text) return [];
        return [{ type: 'agent:text', text: plan.text }];
      }

      return [];
    }

    // -----------------------------------------------------------------------
    // delta → agent:text-delta (streaming text)
    // -----------------------------------------------------------------------
    case 'as:delta':
      if (!event.text) return [];
      return [{ type: 'agent:text-delta', text: event.text }];

    // -----------------------------------------------------------------------
    // reasoning.delta → agent:thinking-delta
    // -----------------------------------------------------------------------
    case 'as:reasoning.delta':
      if (!event.text) return [];
      return [{ type: 'agent:thinking-delta', text: event.text }];

    // -----------------------------------------------------------------------
    // cmd-delta → agent:text-delta (streaming command output; fromDelta=true
    // so the frontend doesn't double-render with the completed aggregatedOutput)
    // -----------------------------------------------------------------------
    case 'as:cmd-delta':
      if (!event.text) return [];
      return [{ type: 'agent:text-delta', text: event.text, fromDelta: true }];

    // -----------------------------------------------------------------------
    // plan-delta → agent:text-delta (streaming plan text; fromDelta=true
    // prevents double-render when item/completed with type plan fires)
    // -----------------------------------------------------------------------
    case 'as:plan-delta':
      if (!event.text) return [];
      return [{ type: 'agent:text-delta', text: event.text, fromDelta: true }];

    // -----------------------------------------------------------------------
    // info → system:info
    // -----------------------------------------------------------------------
    case 'as:info':
      return [{ type: 'system:info', message: event.message }];

    case 'as:compact-start':
      return [{ type: 'system:compact-start', trigger: 'auto' }];

    // -----------------------------------------------------------------------
    // turn.completed → agent:result
    // -----------------------------------------------------------------------
    case 'as:turn.completed': {
      if (event.status === 'failed' || event.error) {
        const errMsg = event.error?.message ?? 'Turn failed';
        return [
          {
            type: 'agent:result',
            costUsd: null,
            turns: 1,
            durationMs: null,
            isError: true,
            errors: [errMsg],
          },
          { type: 'system:error', message: `Codex turn failed: ${errMsg}` },
        ];
      }
      // A turn interrupted by compaction must NOT emit agent:result.
      // Emitting agent:result here would transition the session to awaiting_input,
      // requiring the user to manually re-send — and with the old token counter bug
      // that would immediately trigger another compaction (infinite loop).
      // Instead, return a system:info so the user sees what happened, then let
      // Codex's native compaction complete and resume naturally.
      if (event.status === 'interrupted') {
        return [{ type: 'system:info', message: 'Turn interrupted — compacting context…' }];
      }
      return [
        {
          type: 'agent:result',
          costUsd: null,
          turns: 1,
          durationMs: null,
        },
      ];
    }

    // -----------------------------------------------------------------------
    // error → system:error
    // -----------------------------------------------------------------------
    case 'as:error':
      return [{ type: 'system:error', message: `Codex error: ${event.message}` }];

    // -----------------------------------------------------------------------
    // usage → agent:usage (context bar for Codex sessions)
    // -----------------------------------------------------------------------
    case 'as:usage':
      return [{ type: 'agent:usage', used: event.used, size: event.size }];

    // -----------------------------------------------------------------------
    // diff-update → system:info (aggregated unified diff for turn)
    // -----------------------------------------------------------------------
    case 'as:diff-update':
      if (!event.diff) return [];
      return [{ type: 'system:info', message: `Turn diff:\n\`\`\`diff\n${event.diff}\n\`\`\`` }];

    // -----------------------------------------------------------------------
    // skills → session:commands (Codex uses $skill-name prefix, not /)
    // -----------------------------------------------------------------------
    case 'as:skills': {
      const cmds = event.skills.map((s) => ({
        name: '$' + s.name,
        description: s.shortDescription ?? s.description ?? s.name,
        argumentHint: '',
      }));
      if (cmds.length === 0) return [];
      return [{ type: 'session:commands', slashCommands: cmds }];
    }

    default:
      return [];
  }
}

/**
 * Returns true if the parsed JSON object is an app-server synthetic event.
 */
export function isAppServerSyntheticEvent(
  parsed: Record<string, unknown>,
): parsed is AppServerSyntheticEvent {
  return typeof parsed.type === 'string' && parsed.type.startsWith('as:');
}

// ---------------------------------------------------------------------------
// ThreadItem normalization (camelCase app-server → adapter format)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Codex app-server ThreadItem into our typed AppServerItem.
 *
 * @param item - Raw ThreadItem from the app-server notification params.
 * @param onCompactingReset - Optional callback invoked when a `contextCompaction`
 *   item is received, signalling the adapter to reset its compacting flag.
 */
export function normalizeThreadItem(
  item: Record<string, unknown>,
  onCompactingReset?: () => void,
): AppServerItem | null {
  const type = item.type as string;

  switch (type) {
    case 'agentMessage':
      return {
        type: 'agentMessage',
        id: item.id as string,
        text: (item.text as string) ?? '',
      } as AppServerAgentMessageItem;

    case 'reasoning':
      return {
        type: 'reasoning',
        id: item.id as string,
        summary: (item.summary as string[]) ?? [],
        content: (item.content as string[]) ?? [],
      } as AppServerReasoningItem;

    case 'commandExecution':
      return {
        type: 'commandExecution',
        id: item.id as string,
        command: (item.command as string) ?? '',
        cwd: (item.cwd as string) ?? '',
        exitCode: (item.exitCode as number | null) ?? null,
        aggregatedOutput: (item.aggregatedOutput as string | null) ?? null,
        status: (item.status as string) ?? '',
      } as AppServerCommandExecutionItem;

    case 'fileChange': {
      const rawChanges = (item.changes as Array<Record<string, unknown>>) ?? [];
      return {
        type: 'fileChange',
        id: item.id as string,
        changes: rawChanges.map((c) => ({
          path: (c.path as string) ?? (c.oldPath as string) ?? '',
          kind: (c.kind as string) ?? '',
          newPath: c.newPath as string | null,
        })),
        status: (item.status as string) ?? '',
      } as AppServerFileChangeItem;
    }

    case 'mcpToolCall':
      return {
        type: 'mcpToolCall',
        id: item.id as string,
        server: (item.server as string) ?? '',
        tool: (item.tool as string) ?? '',
        arguments: (item.arguments as Record<string, unknown>) ?? {},
        result: (item.result as { output?: string | null } | null) ?? null,
        error: (item.error as { message: string } | null) ?? null,
        status: (item.status as string) ?? '',
      } as AppServerMcpToolCallItem;

    case 'plan':
      return {
        type: 'plan',
        id: item.id as string,
        text: (item.text as string) ?? '',
      };

    case 'contextCompaction':
      onCompactingReset?.();
      return { type: 'contextCompaction', id: item.id as string };

    default:
      return null;
  }
}
