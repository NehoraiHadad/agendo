/**
 * Claude SDK Adapter — drives Claude Code via @anthropic-ai/claude-agent-sdk
 * instead of spawning a CLI process and parsing raw NDJSON.
 *
 * The SDK gives us typed SDKMessage objects. We map them directly to
 * AgendoEventPayloads via mapSdkMessageToAgendoEvents() and emit them through
 * the ManagedProcess.onEvents() callback — bypassing the NDJSON string pipe
 * entirely. SessionDataPipeline.processEvents() handles suppression, enrichment,
 * and final emission (log write + PG NOTIFY) the same way as the NDJSON path.
 */

import {
  query,
  type Query,
  type SDKUserMessage,
  type PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type {
  AgentAdapter,
  ManagedProcess,
  SpawnOpts,
  ImageContent,
  PermissionDecision,
  ToolApprovalFn,
  ActivityCallbacks,
} from '@/lib/worker/adapters/types';
import { buildSdkOptions } from '@/lib/worker/adapters/build-sdk-options';
import {
  mapSdkMessageToAgendoEvents,
  type SdkEventMapperCallbacks,
} from '@/lib/worker/adapters/sdk-event-mapper';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { createLogger } from '@/lib/logger';

const log = createLogger('claude-sdk-adapter');

// ---------------------------------------------------------------------------
// AsyncQueue — feeds multi-turn messages into the SDK's prompt iterable
// ---------------------------------------------------------------------------

class AsyncQueue<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) {
      log.warn('AsyncQueue.push() called after end() — message dropped');
      return;
    }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  get isDone(): boolean {
    return this.done;
  }

  end(): void {
    this.done = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const item = this.queue.shift() as T;
          return Promise.resolve({ value: item, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiting = resolve;
        });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// ClaudeSdkAdapter
// ---------------------------------------------------------------------------

export class ClaudeSdkAdapter implements AgentAdapter {
  private queryInstance: Query | null = null;
  private inputQueue = new AsyncQueue<SDKUserMessage>();
  private alive = false;
  private eventCallbacks: Array<(payloads: AgendoEventPayload[]) => void> = [];
  private exitCallbacks: Array<(code: number | null) => void> = [];
  private thinkingCallback: ((thinking: boolean) => void) | null = null;
  private approvalHandler: ToolApprovalFn | null = null;
  private sessionRefCallback: ((ref: string) => void) | null = null;
  private activityCallbacks: ActivityCallbacks | null = null;
  /** Cached SdkEventMapperCallbacks — built once on first runQueryLoop call. */
  private sdkCallbacks: SdkEventMapperCallbacks | null = null;
  /** Last assistant message UUID for conversation branching. */
  lastAssistantUuid?: string;

  // -------------------------------------------------------------------------
  // AgentAdapter interface
  // -------------------------------------------------------------------------

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this._start(prompt, opts);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    return this._start(prompt, opts, sessionRef);
  }

  extractSessionId(_output: string): string | null {
    // Not needed — session ID comes from system:init event via onSessionRef callback
    return null;
  }

  async sendMessage(message: string, image?: ImageContent): Promise<void> {
    if (!this.alive || this.inputQueue.isDone) {
      throw new Error('SDK query is not active');
    }

    let msgContent: MessageParam['content'];
    if (image) {
      const blocks: ContentBlockParam[] = [];
      if (message.trim()) {
        blocks.push({ type: 'text', text: message });
      }
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          data: image.data,
        },
      });
      msgContent = blocks;
    } else {
      msgContent = message;
    }

    this.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: msgContent },
      session_id: '',
      parent_tool_use_id: null,
    });
  }

  async sendToolResult(toolUseId: string, content: string): Promise<void> {
    if (!this.alive || this.inputQueue.isDone) {
      throw new Error('SDK query is not active');
    }

    const toolResultBlock: ContentBlockParam = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
    };
    this.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: [toolResultBlock] },
      session_id: '',
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> {
    if (this.queryInstance) {
      try {
        await this.queryInstance.interrupt();
      } catch (err) {
        log.debug({ err }, 'interrupt() failed, closing query');
        this.queryInstance?.close();
      }
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  onThinkingChange(cb: (thinking: boolean) => void): void {
    this.thinkingCallback = cb;
  }

  setApprovalHandler(handler: ToolApprovalFn): void {
    this.approvalHandler = handler;
  }

  onSessionRef(cb: (ref: string) => void): void {
    this.sessionRefCallback = cb;
  }

  setActivityCallbacks(callbacks: ActivityCallbacks): void {
    this.activityCallbacks = callbacks;
    // Invalidate cached callbacks so they pick up the new activityCallbacks
    this.sdkCallbacks = null;
  }

  async setPermissionMode(mode: string): Promise<boolean> {
    if (!this.queryInstance) {
      log.debug({ mode }, 'setPermissionMode called but queryInstance is null');
      return false;
    }
    try {
      await this.queryInstance.setPermissionMode(
        mode as 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk',
      );
      return true;
    } catch (err) {
      log.warn({ err, mode }, 'setPermissionMode failed');
      return false;
    }
  }

  async setModel(model: string): Promise<boolean> {
    if (!this.queryInstance) {
      log.debug({ model }, 'setModel called but queryInstance is null');
      return false;
    }
    try {
      await this.queryInstance.setModel(model);
      return true;
    } catch (err) {
      log.warn({ err, model }, 'setModel failed');
      return false;
    }
  }

  async setMcpServers(servers: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!this.queryInstance) {
      log.debug('setMcpServers called but queryInstance is null');
      return null;
    }
    try {
      const result = await this.queryInstance.setMcpServers(
        servers as Parameters<Query['setMcpServers']>[0],
      );
      return result as unknown as Record<string, unknown>;
    } catch (err) {
      log.warn({ err }, 'setMcpServers failed');
      return null;
    }
  }

  async reconnectMcpServer(serverName: string): Promise<void> {
    if (!this.queryInstance) {
      log.debug({ serverName }, 'reconnectMcpServer called but queryInstance is null');
      return;
    }
    await this.queryInstance.reconnectMcpServer(serverName);
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    if (!this.queryInstance) {
      log.debug({ serverName, enabled }, 'toggleMcpServer called but queryInstance is null');
      return;
    }
    await this.queryInstance.toggleMcpServer(serverName, enabled);
  }

  async rewindFiles(
    userMessageId: string,
    dryRun?: boolean,
  ): Promise<Record<string, unknown> | null> {
    if (!this.queryInstance) {
      log.debug('rewindFiles called but queryInstance is null');
      return null;
    }
    try {
      const result = await this.queryInstance.rewindFiles(userMessageId, { dryRun });
      return result as unknown as Record<string, unknown>;
    } catch (err) {
      log.warn({ err, userMessageId }, 'rewindFiles failed');
      return null;
    }
  }

  async getMcpStatus(): Promise<Record<string, unknown> | null> {
    if (!this.queryInstance) {
      log.debug('getMcpStatus called but queryInstance is null');
      return null;
    }
    try {
      const statuses = await this.queryInstance.mcpServerStatus();
      return { servers: statuses };
    } catch (err) {
      log.warn({ err }, 'getMcpStatus failed');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Private implementation
  // -------------------------------------------------------------------------

  /** Build or return cached SdkEventMapperCallbacks. */
  private getSdkCallbacks(): SdkEventMapperCallbacks {
    if (!this.sdkCallbacks) {
      this.sdkCallbacks = {
        clearDeltaBuffers: () => this.activityCallbacks?.clearDeltaBuffers(),
        appendDelta: (text) => this.activityCallbacks?.appendDelta(text),
        appendThinkingDelta: (text) => this.activityCallbacks?.appendThinkingDelta(text),
        onMessageStart: (stats) => this.activityCallbacks?.onMessageStart?.(stats),
        onResultStats: (costUsd, turns) => this.activityCallbacks?.onResultStats?.(costUsd, turns),
        onSessionRef: (ref) => this.sessionRefCallback?.(ref),
        onAssistantUuid: (uuid) => {
          this.lastAssistantUuid = uuid;
        },
        onThinkingChange: (thinking) => this.thinkingCallback?.(thinking),
      };
    }
    return this.sdkCallbacks;
  }

  private _start(prompt: string, opts: SpawnOpts, resumeRef?: string): ManagedProcess {
    this.alive = true;
    this.eventCallbacks = [];
    this.exitCallbacks = [];
    this.inputQueue = new AsyncQueue<SDKUserMessage>();
    this.lastAssistantUuid = undefined;
    this.sdkCallbacks = null;

    // Build canUseTool callback that delegates to the approval handler
    const canUseTool = this.buildCanUseTool();

    // Build SDK options from SpawnOpts, then spread in resume/fork options.
    // IMPORTANT: when resuming, omit sessionId — passing both --resume and
    // --session-id causes Claude CLI to fail with "No conversation found"
    // because --session-id overrides the resume lookup.
    const baseOptions = buildSdkOptions(opts, canUseTool);
    const sdkOptions = {
      ...baseOptions,
      ...(resumeRef
        ? {
            resume: resumeRef,
            sessionId: undefined, // must not conflict with resume
            ...(opts.resumeSessionAt ? { resumeSessionAt: opts.resumeSessionAt } : {}),
            ...(opts.forkSession ? { forkSession: opts.forkSession } : {}),
          }
        : {}),
    };

    // Build initial message content
    let initialContent: MessageParam['content'] = prompt;
    if (opts.initialImage) {
      const img = opts.initialImage;
      initialContent = [
        { type: 'text', text: prompt },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.data,
          },
        },
      ];
    }

    // Push the initial message into the queue
    this.inputQueue.push({
      type: 'user',
      message: { role: 'user', content: initialContent },
      session_id: '',
      parent_tool_use_id: null,
    });

    // Create the query with the async input queue for multi-turn
    this.queryInstance = query({
      prompt: this.inputQueue as AsyncIterable<SDKUserMessage>,
      options: sdkOptions,
    });

    // Start the async iteration loop (fire and forget)
    this.runQueryLoop().catch((err) => {
      log.error({ err }, 'runQueryLoop unexpected error');
    });

    return {
      pid: 0, // SDK doesn't use OS PIDs — ActivityTracker has `if (pid)` guard
      kill: (_signal: NodeJS.Signals) => {
        this.queryInstance?.close();
      },
      // No NDJSON stdout — this adapter emits typed events directly via onEvents.
      onData: (_cb) => {},
      onExit: (cb) => this.exitCallbacks.push(cb),
      onEvents: (cb) => this.eventCallbacks.push(cb),
    };
  }

  private async runQueryLoop(): Promise<void> {
    let exitCode = 0;
    try {
      const q = this.queryInstance;
      if (!q) return;
      for await (const msg of q) {
        // Map the typed SDKMessage directly to AgendoEventPayloads — no JSON round-trip.
        const payloads = mapSdkMessageToAgendoEvents(msg, this.getSdkCallbacks());
        if (payloads.length > 0) {
          for (const cb of this.eventCallbacks) cb(payloads);
        }
      }
    } catch (err) {
      exitCode = 1;
      // Emit a synthetic error event directly
      const errPayloads: AgendoEventPayload[] = [{ type: 'system:error', message: String(err) }];
      for (const cb of this.eventCallbacks) cb(errPayloads);
    } finally {
      this.alive = false;
      this.inputQueue.end();
      for (const cb of this.exitCallbacks) cb(exitCode);
    }
  }

  private buildCanUseTool() {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: { toolUseID: string; signal: AbortSignal },
    ): Promise<PermissionResult> => {
      if (!this.approvalHandler) {
        return { behavior: 'allow' };
      }

      const decision = await this.approvalHandler({
        approvalId: options.toolUseID,
        toolName,
        toolInput: input,
      });

      return this.mapDecisionToPermissionResult(decision);
    };
  }

  private mapDecisionToPermissionResult(decision: PermissionDecision): PermissionResult {
    if (decision === 'deny') {
      return { behavior: 'deny', message: 'User denied' };
    }

    if (decision === 'allow' || decision === 'allow-session') {
      return { behavior: 'allow' };
    }

    // Object form with potential updatedInput
    if (typeof decision === 'object') {
      return {
        behavior: 'allow',
        ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
      };
    }

    // Fallback
    return { behavior: 'allow' };
  }
}
