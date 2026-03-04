import type { AgendoEventPayload } from '@/lib/realtime/events';

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
  | { type: 'as:turn.completed'; status: string; error: AppServerTurnError | null }
  | { type: 'as:error'; message: string };

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
      return [
        {
          type: 'agent:tool-start',
          toolUseId: item.id,
          toolName: toolNameForItem(item),
          input: toolInputForItem(item),
        },
      ];
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
        return [{ type: 'agent:tool-end', toolUseId: cmd.id, content }];
      }

      if (item.type === 'fileChange') {
        const fc = item as AppServerFileChangeItem;
        const content = fc.changes.map((c) => `${c.kind}: ${c.path}`).join('\n');
        return [{ type: 'agent:tool-end', toolUseId: fc.id, content }];
      }

      if (item.type === 'mcpToolCall') {
        const mcp = item as AppServerMcpToolCallItem;
        const content = mcp.result?.output ?? mcp.error?.message ?? '';
        return [{ type: 'agent:tool-end', toolUseId: mcp.id, content }];
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
