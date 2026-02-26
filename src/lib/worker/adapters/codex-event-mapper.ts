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
  content?: CodexContentBlock[];
}

interface CodexCommandItem extends CodexItemBase {
  type: 'command_execution';
  command?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
}

interface CodexFileSearchItem extends CodexItemBase {
  type: 'file_search';
  results?: string[];
}

interface CodexMcpCallItem extends CodexItemBase {
  type: 'mcp_call';
  name?: string;
  arguments?: string;
}

interface CodexReasoningItem extends CodexItemBase {
  type: 'reasoning';
}

interface CodexAgentMessageItem extends CodexItemBase {
  type: 'agent_message';
}

type CodexItem =
  | CodexCommandItem
  | CodexFileSearchItem
  | CodexMcpCallItem
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
  | { type: 'error'; error: { message: string } };

// ---------------------------------------------------------------------------
// Tool item types that produce tool-start/tool-end events
// ---------------------------------------------------------------------------

const TOOL_ITEM_TYPES = new Set(['command_execution', 'file_search', 'mcp_call']);

function toolNameForItem(item: CodexItem): string {
  switch (item.type) {
    case 'command_execution':
      return 'Bash';
    case 'file_search':
      return 'FileSearch';
    case 'mcp_call':
      return (item as CodexMcpCallItem).name ?? 'MCP';
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
    case 'mcp_call': {
      const mcp = item as CodexMcpCallItem;
      if (mcp.arguments) {
        try {
          return JSON.parse(mcp.arguments) as Record<string, unknown>;
        } catch {
          return { arguments: mcp.arguments };
        }
      }
      return {};
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
        const texts = (item.content ?? [])
          .filter((b) => typeof b.text === 'string')
          .map((b) => b.text as string);
        return [{ type: 'agent:thinking', text: texts.join('\n') }];
      }

      // agent_message → agent:text
      if (item.type === 'agent_message') {
        const texts = (item.content ?? [])
          .filter((b) => b.type === 'output_text' && typeof b.text === 'string')
          .map((b) => b.text as string);
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

      // file_search → agent:tool-end
      if (item.type === 'file_search') {
        const fs = item as CodexFileSearchItem;
        return [
          {
            type: 'agent:tool-end',
            toolUseId: fs.call_id ?? fs.id ?? '',
            content: JSON.stringify(fs.results ?? []),
          },
        ];
      }

      // mcp_call → agent:tool-end
      if (item.type === 'mcp_call') {
        const mcp = item as CodexMcpCallItem;
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
    case 'error':
      return [
        {
          type: 'system:error',
          message: `Codex error: ${event.error.message}`,
        },
      ];

    default:
      return [];
  }
}
