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
import type { OpenCodeEvent } from '@/lib/worker/adapters/opencode-event-mapper';
import type { ToolApprovalFn } from '@/lib/worker/adapters/types';
import {
  createAcpClientHandler,
  extractMessage,
  type AcpClientHandlerInstance,
} from '@/lib/worker/adapters/base-acp-client-handler';

export { extractMessage };

/**
 * ACP Client implementation for OpenCode. Handles incoming agent requests:
 *  - requestPermission  — tool approval in default/acceptEdits mode
 *  - sessionUpdate      — streaming text, thinking, tool-call events
 *  - readTextFile       — agent reads a file from the client filesystem
 *  - writeTextFile      — agent writes a file to the client filesystem
 *
 * OpenCode's permission option IDs: "once", "always", "reject"
 * Option kinds: "allow_once", "allow_always", "reject_once"
 * The handler finds options by kind, so the different optionIds are transparent.
 *
 * Note: no terminal support — OpenCode does not use the ACP terminal protocol.
 * Note: no slash commands — OpenCode uses agents, not slash commands.
 */
export class OpenCodeClientHandler implements Client {
  private readonly handler: AcpClientHandlerInstance;

  constructor(
    emitNdjson: (event: OpenCodeEvent) => void,
    getApprovalHandler: () => ToolApprovalFn | null,
    activeToolCalls: Set<string>,
  ) {
    this.handler = createAcpClientHandler(
      {
        agentPrefix: 'opencode',
        supportsTerminal: false,
        supportsCommands: false,
        supportsSessionInfo: false,
        supportsUsageCost: false,
      },
      emitNdjson,
      getApprovalHandler,
      activeToolCalls,
    );
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

  // releaseAllTerminals is a no-op for OpenCode (no terminal handler instantiated)
  releaseAllTerminals(): void {
    this.handler.releaseAllTerminals();
  }
}
