import { readFileSync, writeFileSync } from 'node:fs';
import { createLogger } from '@/lib/logger';
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  KillTerminalCommandRequest,
  KillTerminalCommandResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
} from '@agentclientprotocol/sdk';
import type { ToolApprovalFn } from '@/lib/worker/adapters/types';
import { AcpTerminalHandler } from '@/lib/worker/adapters/acp-terminal-handler';

// ---------------------------------------------------------------------------
// Shared ACP client handler factory
// ---------------------------------------------------------------------------
// Gemini, Copilot, and OpenCode ACP client handlers share identical logic.
// The only runtime differences are the event type prefix (gemini:, copilot:,
// opencode:) and which optional features each agent supports (terminals,
// slash commands, session-info, usage cost).
// ---------------------------------------------------------------------------

/**
 * Extract a string message from any thrown value.
 * The SDK rejects with the raw JSON-RPC error object { code, message } (not an
 * Error instance) when the agent sends an error response. Without this helper,
 * String(err) produces "[object Object]".
 */
export function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

/** Auto-incrementing ID for synthetic tool-use events (permission-mode flow). */
let toolUseCounter = 0;

/** Minimal event shape used internally — matches all ACP agent event unions. */
type AcpEvent = { type: string; [key: string]: unknown };

/** Emit callback type accepted by all ACP adapters. */
type EmitFn<TEvent extends AcpEvent> = (event: TEvent) => void;

/**
 * Configuration passed once when creating a handler instance.
 *
 * - `agentPrefix`     — event type prefix, e.g. `'gemini'` → `gemini:tool-start`
 * - `supportsTerminal`— whether to expose createTerminal/killTerminal/etc (default: false)
 * - `supportsCommands`— whether to handle `available_commands_update` (default: false)
 * - `supportsSessionInfo` — whether to handle `session_info_update` (default: false)
 * - `supportsUsageCost`   — whether to forward the optional `cost` field in usage events (default: false)
 */
export interface AcpClientHandlerConfig {
  agentPrefix: string;
  supportsTerminal?: boolean;
  supportsCommands?: boolean;
  supportsSessionInfo?: boolean;
  supportsUsageCost?: boolean;
}

/**
 * The public interface of a handler instance returned by `createAcpClientHandler`.
 *
 * Declares all always-present methods as required (the ACP `Client` interface marks
 * some of them optional, which would cause "possibly undefined" errors in callers).
 * Terminal methods remain optional — only present when `supportsTerminal: true`.
 */
export interface AcpClientHandlerInstance extends Client {
  releaseAllTerminals(): void;
  // Promote to required (they are always provided by the factory)
  requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  sessionUpdate(params: SessionNotification): Promise<void>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}

/**
 * Factory that creates an ACP `Client` implementation for any ACP-based agent.
 *
 * Usage:
 * ```ts
 * const handler = createAcpClientHandler(
 *   { agentPrefix: 'gemini', supportsTerminal: true, supportsCommands: true,
 *     supportsSessionInfo: true, supportsUsageCost: true },
 *   emit,
 *   getApprovalHandler,
 *   activeToolCalls,
 * );
 * ```
 */
export function createAcpClientHandler<TEvent extends AcpEvent>(
  config: AcpClientHandlerConfig,
  emitNdjson: EmitFn<TEvent>,
  getApprovalHandler: () => ToolApprovalFn | null,
  activeToolCalls: Set<string>,
): AcpClientHandlerInstance {
  const {
    agentPrefix,
    supportsTerminal = false,
    supportsCommands = false,
    supportsSessionInfo = false,
    supportsUsageCost = false,
  } = config;

  const log = createLogger(`${agentPrefix}-client-handler`);
  const terminalHandler = supportsTerminal ? new AcpTerminalHandler() : null;

  /** Emit a typed event using the agent-specific prefix. */
  function emit(suffix: string, fields: Record<string, unknown>): void {
    emitNdjson({ type: `${agentPrefix}:${suffix}`, ...fields } as unknown as TEvent);
  }

  function releaseAllTerminals(): void {
    terminalHandler?.releaseAll();
  }

  async function requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const { toolCall, options } = params;
    const toolName = toolCall.title ?? 'unknown';
    const toolInput = (toolCall.rawInput as Record<string, unknown> | undefined) ?? {};
    const toolUseId = toolCall.toolCallId ?? `${agentPrefix}-tool-${++toolUseCounter}`;

    emit('tool-start', { toolName, toolInput, toolUseId });

    const approvalHandler = getApprovalHandler();
    if (!approvalHandler) {
      const allowOption =
        options.find((o) => o.kind === 'allow_always') ??
        options.find((o) => o.kind === 'allow_once') ??
        options[0];
      emit('tool-end', { toolUseId });
      return { outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? '' } };
    }

    const approvalId = `${agentPrefix}-perm-${toolUseId}`;
    try {
      const decision = await approvalHandler({ approvalId, toolName, toolInput });
      let chosenOption;
      if (decision === 'deny') {
        chosenOption = options.find((o) => o.kind === 'reject_once') ?? options[options.length - 1];
      } else if (decision === 'allow-session') {
        chosenOption =
          options.find((o) => o.kind === 'allow_always') ??
          options.find((o) => o.kind === 'allow_once') ??
          options[0];
      } else {
        // 'allow' or { behavior: 'allow', updatedInput } → one-time approval
        chosenOption = options.find((o) => o.kind === 'allow_once') ?? options[0];
      }
      emit('tool-end', { toolUseId });
      return { outcome: { outcome: 'selected', optionId: chosenOption?.optionId ?? '' } };
    } catch (err) {
      log.error({ err }, 'approvalHandler failed, auto-allowing');
      const allowOption =
        options.find((o) => o.kind === 'allow_always') ??
        options.find((o) => o.kind === 'allow_once') ??
        options[0];
      emit('tool-end', { toolUseId });
      return { outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? '' } };
    }
  }

  async function sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          emit('text-delta', { text: update.content.text });
        }
        break;
      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          emit('thinking-delta', { text: update.content.text });
        }
        break;
      case 'tool_call': {
        const { toolCallId, title, kind, locations } = update;
        const filePath = locations?.[0]?.path;
        const extractedName = toolCallId?.replace(/-\d+$/, '') ?? '';
        const baseName = extractedName || title || 'unknown';
        const toolName = filePath
          ? `${baseName} (${filePath})`
          : title && title !== '{}' && extractedName && title !== extractedName
            ? `${extractedName}: ${title}`
            : baseName;
        const id = toolCallId ?? `${agentPrefix}-tool-${++toolUseCounter}`;
        activeToolCalls.add(id);
        emit('tool-start', { toolName, toolInput: kind ? { kind } : {}, toolUseId: id });
        break;
      }
      case 'plan':
        emit('plan', {
          entries: update.entries.map((e) => ({
            content: e.content,
            priority: e.priority,
            status: e.status,
          })),
        });
        break;
      case 'current_mode_update':
        emit('mode-change', { modeId: update.currentModeId });
        break;
      case 'usage_update': {
        const cost = supportsUsageCost
          ? (update as unknown as { cost?: { amount: number; currency: string } | null }).cost
          : undefined;
        emit('usage', {
          used: update.used,
          size: update.size,
          ...(cost ? { cost } : {}),
        });
        break;
      }
      case 'session_info_update': {
        if (supportsSessionInfo) {
          const info = update as unknown as { title?: string | null };
          emit('session-info', { title: info.title ?? null });
        }
        break;
      }
      case 'available_commands_update': {
        if (supportsCommands) {
          emit('commands', {
            commands: (update.availableCommands ?? []).map((cmd) => ({
              name: cmd.name,
              description: cmd.description,
              argumentHint: '',
            })),
          });
        }
        break;
      }
      case 'tool_call_update': {
        const { toolCallId, content, status } = update;
        if (toolCallId && activeToolCalls.has(toolCallId)) {
          activeToolCalls.delete(toolCallId);
          const resultText = (content ?? [])
            .filter((c): c is typeof c & { type: 'content' } => c.type === 'content')
            .map((c) => (c.content.type === 'text' ? c.content.text : ''))
            .filter(Boolean)
            .join('\n');
          emit('tool-end', {
            toolUseId: toolCallId,
            ...(resultText ? { resultText } : {}),
            ...(status === 'failed' ? { failed: true } : {}),
          });
        }
        // else: default mode — permission handler already emitted start+end
        break;
      }
      default:
        break;
    }
  }

  async function readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    try {
      let content = readFileSync(params.path, 'utf-8');
      if (params.line != null) {
        const lines = content.split('\n');
        const start = Math.max(0, params.line - 1);
        const end = params.limit ? start + params.limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      return { content };
    } catch {
      return { content: '' };
    }
  }

  async function writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    try {
      writeFileSync(params.path, params.content, 'utf-8');
    } catch {
      /* ignore write errors */
    }
    return {};
  }

  // Terminal methods — only wired up when supportsTerminal is true.
  // The ACP Client interface makes all methods optional, so omitting them
  // is correct for agents that don't support terminals.
  // We build the optional terminal method bag only when the handler is present,
  // keeping the reference typed as AcpTerminalHandler (not null) inside the closures.

  const terminalMethods: Partial<AcpClientHandlerInstance> = {};
  if (terminalHandler !== null) {
    const th: AcpTerminalHandler = terminalHandler;

    terminalMethods.createTerminal = async (
      params: CreateTerminalRequest,
    ): Promise<CreateTerminalResponse> => {
      const result = await th.createTerminal({
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        env: params.env as Array<{ name: string; value: string }> | undefined,
        maxOutputBytes: params.outputByteLimit ?? undefined,
      });
      return { terminalId: result.terminalId };
    };

    terminalMethods.terminalOutput = async (
      params: TerminalOutputRequest,
    ): Promise<TerminalOutputResponse> => th.getTerminalOutputResponse(params.terminalId);

    terminalMethods.waitForTerminalExit = async (
      params: WaitForTerminalExitRequest,
    ): Promise<WaitForTerminalExitResponse> => {
      const status = await th.waitForTerminalExit(params.terminalId);
      return { exitCode: status.exitCode, signal: status.signal };
    };

    terminalMethods.killTerminal = async (
      params: KillTerminalCommandRequest,
    ): Promise<KillTerminalCommandResponse> => {
      th.killTerminal(params.terminalId);
      return {};
    };

    terminalMethods.releaseTerminal = async (
      params: ReleaseTerminalRequest,
    ): Promise<ReleaseTerminalResponse> => {
      th.releaseTerminal(params.terminalId);
      return {};
    };
  }

  const handler: AcpClientHandlerInstance = {
    releaseAllTerminals,
    requestPermission,
    sessionUpdate,
    readTextFile,
    writeTextFile,
    ...terminalMethods,
  };

  return handler;
}
