import type { AgendoEventPayload } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Codex JSONL event types (from `codex exec --json`)
// ---------------------------------------------------------------------------

interface CodexContentBlock {
  type: string;
  text?: string;
}

interface CodexItemBase {
  type: string;
  id?: string;
  call_id?: string;
  text?: string;
  content?: CodexContentBlock[];
}

interface CodexCommandItem extends CodexItemBase {
  type: 'command_execution';
  command?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

interface CodexFileChangeItem extends CodexItemBase {
  type: 'file_change';
  changes?: Array<{ path: string; kind: string }>;
  status?: string;
}

interface CodexMcpToolCallItem extends CodexItemBase {
  type: 'mcp_tool_call';
  server?: string;
  tool?: string;
  status?: string;
}

interface CodexReasoningItem extends CodexItemBase {
  type: 'reasoning';
}

interface CodexAgentMessageItem extends CodexItemBase {
  type: 'agent_message';
}

type CodexItem =
  | CodexCommandItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexReasoningItem
  | CodexAgentMessageItem
  | CodexItemBase;

export type CodexEvent =
  | { type: 'thread.started'; thread_id: string; thread_created_at?: string }
  | { type: 'turn.started' }
  | { type: 'item.started'; item: CodexItem }
  | { type: 'item.completed'; item: CodexItem }
  | {
      type: 'turn.completed';
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cached_input_tokens?: number;
      };
    }
  | { type: 'turn.failed'; error: { message: string; code?: string } }
  | { type: 'error'; error?: { message: string }; message?: string }
  | { type: 'codex:init'; model: string };

// ---------------------------------------------------------------------------
// Tool item types that produce tool-start/tool-end events
// ---------------------------------------------------------------------------

const TOOL_ITEM_TYPES = new Set(['command_execution', 'file_change', 'mcp_tool_call']);

function toolNameForItem(item: CodexItem): string {
  switch (item.type) {
    case 'command_execution':
      return 'Bash';
    case 'file_change':
      return 'FileChange';
    case 'mcp_tool_call':
      return (item as CodexMcpToolCallItem).tool ?? 'MCP';
    default:
      return item.type;
  }
}

function toolInputForItem(item: CodexItem): Record<string, unknown> {
  switch (item.type) {
    case 'command_execution': {
      const cmd = item as CodexCommandItem;
      return cmd.command ? { command: cmd.command } : {};
    }
    case 'file_change': {
      const fc = item as CodexFileChangeItem;
      return fc.changes ? { changes: fc.changes } : {};
    }
    case 'mcp_tool_call': {
      const mcp = item as CodexMcpToolCallItem;
      const input: Record<string, unknown> = {};
      if (mcp.server) input.server = mcp.server;
      if (mcp.tool) input.tool = mcp.tool;
      return input;
    }
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Main mapper: CodexEvent → AgendoEventPayload[]
// ---------------------------------------------------------------------------

export function mapCodexJsonToEvents(event: CodexEvent): AgendoEventPayload[] {
  switch (event.type) {
    // -----------------------------------------------------------------------
    // thread.started → session:init
    // -----------------------------------------------------------------------
    case 'thread.started':
      return [
        {
          type: 'session:init',
          sessionRef: event.thread_id,
          slashCommands: [],
          mcpServers: [],
        },
      ];

    // -----------------------------------------------------------------------
    // codex:init → session:init with model (synthetic, emitted by adapter)
    // -----------------------------------------------------------------------
    case 'codex:init':
      return [
        {
          type: 'session:init',
          sessionRef: '',
          slashCommands: [],
          mcpServers: [],
          model: event.model,
        },
      ];

    // -----------------------------------------------------------------------
    // turn.started → [] (thinking callback handled by adapter, not events)
    // -----------------------------------------------------------------------
    case 'turn.started':
      return [];

    // -----------------------------------------------------------------------
    // item.started → agent:tool-start for tool types
    // -----------------------------------------------------------------------
    case 'item.started': {
      const { item } = event;
      if (!TOOL_ITEM_TYPES.has(item.type)) return [];
      return [
        {
          type: 'agent:tool-start',
          toolUseId: item.call_id ?? item.id ?? '',
          toolName: toolNameForItem(item),
          input: toolInputForItem(item),
        },
      ];
    }

    // -----------------------------------------------------------------------
    // item.completed → varies by item type
    // -----------------------------------------------------------------------
    case 'item.completed': {
      const { item } = event;

      // reasoning → agent:thinking
      if (item.type === 'reasoning') {
        // Prefer top-level item.text (official JSONL format)
        if (typeof item.text === 'string' && item.text) {
          return [{ type: 'agent:thinking', text: item.text }];
        }
        // Fall back to content array
        const texts = (item.content ?? [])
          .filter((b) => typeof b.text === 'string')
          .map((b) => b.text as string);
        if (texts.length === 0) return [];
        return [{ type: 'agent:thinking', text: texts.join('\n') }];
      }

      // agent_message → agent:text
      if (item.type === 'agent_message') {
        // Prefer top-level item.text (official JSONL format)
        if (typeof item.text === 'string' && item.text) {
          return [{ type: 'agent:text', text: item.text }];
        }
        // Fall back to content array (accept both output_text and text block types)
        const texts = (item.content ?? [])
          .filter(
            (b) => (b.type === 'output_text' || b.type === 'text') && typeof b.text === 'string',
          )
          .map((b) => b.text as string);
        if (texts.length === 0) return [];
        return [{ type: 'agent:text', text: texts.join('\n') }];
      }

      // command_execution → agent:tool-end
      if (item.type === 'command_execution') {
        const cmd = item as CodexCommandItem;
        const exitCode = cmd.exit_code ?? 0;
        const stdout = cmd.stdout ?? '';
        const stderr = cmd.stderr ?? '';
        let content: string;
        if (exitCode !== 0 && stderr) {
          content = `[exit ${exitCode}] ${stderr}`;
        } else {
          content = stdout || stderr;
        }
        return [
          {
            type: 'agent:tool-end',
            toolUseId: cmd.call_id ?? cmd.id ?? '',
            content,
          },
        ];
      }

      // file_change → agent:tool-end
      if (item.type === 'file_change') {
        const fc = item as CodexFileChangeItem;
        const content = fc.changes ? fc.changes.map((c) => `${c.kind}: ${c.path}`).join('\n') : '';
        return [
          {
            type: 'agent:tool-end',
            toolUseId: fc.call_id ?? fc.id ?? '',
            content,
          },
        ];
      }

      // mcp_tool_call → agent:tool-end
      if (item.type === 'mcp_tool_call') {
        const mcp = item as CodexMcpToolCallItem;
        const texts = (mcp.content ?? [])
          .filter((b) => typeof b.text === 'string')
          .map((b) => b.text as string);
        return [
          {
            type: 'agent:tool-end',
            toolUseId: mcp.call_id ?? mcp.id ?? '',
            content: texts.join('\n'),
          },
        ];
      }

      return [];
    }

    // -----------------------------------------------------------------------
    // turn.completed → agent:result with usage
    // -----------------------------------------------------------------------
    case 'turn.completed': {
      const usage = event.usage;
      const result: AgendoEventPayload = {
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
      };

      if (usage && (usage.input_tokens || usage.output_tokens)) {
        (result as Record<string, unknown>).modelUsage = {
          codex: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            ...(usage.cached_input_tokens != null
              ? { cacheReadInputTokens: usage.cached_input_tokens }
              : {}),
            costUSD: 0,
          },
        };
      }
      return [result];
    }

    // -----------------------------------------------------------------------
    // turn.failed → agent:result (isError) + system:error
    // -----------------------------------------------------------------------
    case 'turn.failed':
      return [
        {
          type: 'agent:result',
          costUsd: null,
          turns: 1,
          durationMs: null,
          isError: true,
          subtype: event.error.code,
          errors: [event.error.message],
        },
        {
          type: 'system:error',
          message: `Codex turn failed: ${event.error.message}`,
        },
      ];

    // -----------------------------------------------------------------------
    // error → system:error
    // -----------------------------------------------------------------------
    case 'error': {
      const errMsg = event.error?.message ?? event.message ?? 'Unknown error';
      return [
        {
          type: 'system:error',
          message: `Codex error: ${errMsg}`,
        },
      ];
    }

    default:
      return [];
  }
}
