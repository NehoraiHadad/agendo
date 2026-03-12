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
} from '@agentclientprotocol/sdk';
import type { GeminiEvent } from '@/lib/worker/adapters/gemini-event-mapper';
import type { ToolApprovalFn } from '@/lib/worker/adapters/types';

const log = createLogger('gemini-client-handler');

/** Auto-incrementing ID for synthetic tool-use events (permission-mode flow). */
let toolUseCounter = 0;

/**
 * Extract a string message from any thrown value.
 * The SDK rejects with the raw JSON-RPC error object { code, message } (not an Error
 * instance) when the agent sends an error response. Without this helper, String(err)
 * produces "[object Object]".
 */
export function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

/**
 * ACP Client implementation. Handles incoming agent requests:
 *  - requestPermission  — tool approval in default/acceptEdits mode
 *  - sessionUpdate      — streaming text, thinking, tool-call events
 *  - readTextFile       — agent reads a file from the client filesystem
 *  - writeTextFile      — agent writes a file to the client filesystem
 */
export class GeminiClientHandler implements Client {
  constructor(
    private readonly emitNdjson: (event: GeminiEvent) => void,
    private readonly getApprovalHandler: () => ToolApprovalFn | null,
    private readonly activeToolCalls: Set<string>,
  ) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const { toolCall, options } = params;
    const toolName = toolCall.title ?? 'unknown';
    const toolInput = (toolCall.rawInput as Record<string, unknown> | undefined) ?? {};
    const toolUseId = toolCall.toolCallId ?? `gemini-tool-${++toolUseCounter}`;

    this.emitNdjson({ type: 'gemini:tool-start', toolName, toolInput, toolUseId });

    const approvalHandler = this.getApprovalHandler();
    if (!approvalHandler) {
      const allowOption =
        options.find((o) => o.kind === 'allow_always') ??
        options.find((o) => o.kind === 'allow_once') ??
        options[0];
      this.emitNdjson({ type: 'gemini:tool-end', toolUseId });
      return { outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? '' } };
    }

    const approvalId = `gemini-perm-${toolUseId}`;
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
      this.emitNdjson({ type: 'gemini:tool-end', toolUseId });
      return { outcome: { outcome: 'selected', optionId: chosenOption?.optionId ?? '' } };
    } catch (err) {
      log.error({ err }, 'approvalHandler failed, auto-allowing');
      const allowOption =
        options.find((o) => o.kind === 'allow_always') ??
        options.find((o) => o.kind === 'allow_once') ??
        options[0];
      this.emitNdjson({ type: 'gemini:tool-end', toolUseId });
      return { outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? '' } };
    }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          this.emitNdjson({ type: 'gemini:text-delta', text: update.content.text });
        }
        break;
      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          this.emitNdjson({ type: 'gemini:thinking-delta', text: update.content.text });
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
        const id = toolCallId ?? `gemini-tool-${++toolUseCounter}`;
        this.activeToolCalls.add(id);
        this.emitNdjson({
          type: 'gemini:tool-start',
          toolName,
          toolInput: kind ? { kind } : {},
          toolUseId: id,
        });
        break;
      }
      case 'plan':
        this.emitNdjson({
          type: 'gemini:plan',
          entries: update.entries.map((e) => ({
            content: e.content,
            priority: e.priority,
            status: e.status,
          })),
        });
        break;
      case 'current_mode_update':
        this.emitNdjson({ type: 'gemini:mode-change', modeId: update.currentModeId });
        break;
      case 'usage_update':
        this.emitNdjson({ type: 'gemini:usage', used: update.used, size: update.size });
        break;
      case 'available_commands_update':
        this.emitNdjson({
          type: 'gemini:commands',
          commands: (update.availableCommands ?? []).map((cmd) => ({
            name: cmd.name,
            description: cmd.description,
            argumentHint: '',
          })),
        });
        break;
      case 'tool_call_update': {
        const { toolCallId, content, status } = update;
        if (toolCallId && this.activeToolCalls.has(toolCallId)) {
          this.activeToolCalls.delete(toolCallId);
          const resultText = (content ?? [])
            .filter((c): c is typeof c & { type: 'content' } => c.type === 'content')
            .map((c) => (c.content.type === 'text' ? c.content.text : ''))
            .filter(Boolean)
            .join('\n');
          this.emitNdjson({
            type: 'gemini:tool-end',
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

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
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

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    try {
      writeFileSync(params.path, params.content, 'utf-8');
    } catch {
      /* ignore write errors */
    }
    return {};
  }
}
