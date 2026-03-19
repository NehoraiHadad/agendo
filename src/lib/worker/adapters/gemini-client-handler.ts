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
import type { GeminiEvent } from '@/lib/worker/adapters/gemini-event-mapper';
import type { ToolApprovalFn } from '@/lib/worker/adapters/types';
import {
  createAcpClientHandler,
  extractMessage,
  type AcpClientHandlerInstance,
} from '@/lib/worker/adapters/base-acp-client-handler';

export { extractMessage };

/**
 * ACP Client implementation for Gemini. Handles incoming agent requests:
 *  - requestPermission  — tool approval in default/acceptEdits mode
 *  - sessionUpdate      — streaming text, thinking, tool-call events
 *  - readTextFile       — agent reads a file from the client filesystem
 *  - writeTextFile      — agent writes a file to the client filesystem
 *  - createTerminal / terminalOutput / waitForTerminalExit / killTerminal / releaseTerminal
 */
export class GeminiClientHandler implements Client {
  private readonly handler: AcpClientHandlerInstance;

  constructor(
    emitNdjson: (event: GeminiEvent) => void,
    getApprovalHandler: () => ToolApprovalFn | null,
    activeToolCalls: Set<string>,
  ) {
    this.handler = createAcpClientHandler(
      {
        agentPrefix: 'gemini',
        supportsTerminal: true,
        supportsCommands: true,
        supportsSessionInfo: true,
        supportsUsageCost: true,
      },
      emitNdjson,
      getApprovalHandler,
      activeToolCalls,
    );
  }

  releaseAllTerminals(): void {
    this.handler.releaseAllTerminals();
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return this.handler.requestPermission(params);
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    return this.handler.sessionUpdate(params);
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.handler.readTextFile(params);
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.handler.writeTextFile(params);
  }

  async createTerminal(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    // supportsTerminal: true guarantees this is always present
    return (this.handler.createTerminal ?? (() => Promise.reject(new Error('no terminal'))))(
      params,
    );
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
    return (this.handler.terminalOutput ?? (() => Promise.reject(new Error('no terminal'))))(
      params,
    );
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
  ): Promise<WaitForTerminalExitResponse> {
    return (this.handler.waitForTerminalExit ?? (() => Promise.reject(new Error('no terminal'))))(
      params,
    );
  }

  async killTerminal(params: KillTerminalCommandRequest): Promise<KillTerminalCommandResponse> {
    return (await this.handler.killTerminal?.(params)) ?? {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
    return (await this.handler.releaseTerminal?.(params)) ?? {};
  }
}
