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

import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
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
  ActivityCallbacks,
} from '@/lib/worker/adapters/types';
import { BaseAgentAdapter } from '@/lib/worker/adapters/base-adapter';
import { buildSdkOptions } from '@/lib/worker/adapters/build-sdk-options';
import {
  mapSdkMessageToAgendoEvents,
  type SdkEventMapperCallbacks,
} from '@/lib/worker/adapters/sdk-event-mapper';
import type { AgendoEventPayload, MessagePriority } from '@/lib/realtime/events';
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

export class ClaudeSdkAdapter extends BaseAgentAdapter implements AgentAdapter {
  private queryInstance: Query | null = null;
  private inputQueue = new AsyncQueue<SDKUserMessage>();
  private alive = false;
  private eventCallbacks: Array<(payloads: AgendoEventPayload[]) => void> = [];
  private exitCallbacks: Array<(code: number | null) => void> = [];
  private activityCallbacks: ActivityCallbacks | null = null;
  /** Cached SdkEventMapperCallbacks — built once on first runQueryLoop call. */
  private sdkCallbacks: SdkEventMapperCallbacks | null = null;
  /** Last assistant message UUID for conversation branching. */
  lastAssistantUuid?: string;
  /** Working directory for the current session — used to find project-local custom commands. */
  private spawnCwd = process.cwd();

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

  async sendMessage(
    message: string,
    image?: ImageContent,
    priority?: MessagePriority,
  ): Promise<void> {
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
      // session_id is required by the SDKUserMessage type but ignored by the SDK —
      // QueryInstance manages its own _sessionId internally. The SDK's own send()
      // method also passes '' here (see sdk.mjs). Safe to leave empty.
      session_id: '',
      parent_tool_use_id: null,
      // Priority controls the SDK's internal message queue ordering:
      // 'now' = dequeued first, 'next' = default FIFO, 'later' = dequeued last.
      ...(priority && { priority }),
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
      // session_id: ignored by SDK — see sendMessage() comment above.
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

  async getHistory(
    sessionRef: string,
    cwd?: string,
  ): Promise<import('@/lib/realtime/events').AgendoEventPayload[] | null> {
    const { readClaudeJsonl, mapClaudeJsonlToEvents, mapClaudeSessionMessages } =
      await import('./claude-history');

    // Fast path: read JSONL directly (~1ms, preserves timestamps and full metadata).
    // Falls back to the SDK path when cwd is unknown or the file is missing.
    if (cwd) {
      try {
        const records = readClaudeJsonl(sessionRef, cwd);
        if (records && records.length > 0) {
          return mapClaudeJsonlToEvents(records);
        }
      } catch (err) {
        log.debug({ err, sessionRef }, 'readClaudeJsonl failed — falling back to SDK');
      }
    }

    // Slow path: SDK getSessionMessages() (~89ms, strips timestamps).
    try {
      const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
      const messages = await getSessionMessages(sessionRef, cwd ? { dir: cwd } : undefined);
      if (!messages || messages.length === 0) return null;
      return mapClaudeSessionMessages(messages);
    } catch (err) {
      log.debug({ err, sessionRef }, 'getHistory failed');
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
    this.spawnCwd = opts.cwd;
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

    // Push the initial message into the queue.
    // session_id: ignored by SDK — QueryInstance tracks it internally (see sendMessage()).
    // Even if we had a resumeRef, passing it here is not needed — resume is handled
    // via sdkOptions.resume in the query() call below.
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
      pid: null, // No OS child process — SDK runs in-process.
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
        // After system:init is emitted, enrich with rich command metadata (fire-and-forget)
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.fetchAndEmitRichCommands();
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

  /**
   * Scan ~/.claude/commands/ and {cwd}/.claude/commands/ for custom .md commands.
   * Parses YAML frontmatter to extract description and argument-hint fields.
   * Returns command objects in the same shape as SDK supportedCommands() results.
   */
  private loadCustomCommands(
    cwd: string,
  ): Array<{ name: string; description: string; argumentHint: string }> {
    const dirs = [join(homedir(), '.claude', 'commands'), join(cwd, '.claude', 'commands')];
    const commands: Array<{ name: string; description: string; argumentHint: string }> = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        continue; // directory doesn't exist
      }
      for (const file of files) {
        const name = basename(file, '.md');
        let description = name.replace(/-/g, ' ');
        let argumentHint = '';
        try {
          const content = readFileSync(join(dir, file), 'utf-8');
          const descMatch = content.match(/^description:\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim();
          const hintMatch = content.match(/^argument-hint:\s*(.+)$/m);
          if (hintMatch) argumentHint = hintMatch[1].trim();
        } catch {
          // skip malformed files
        }
        commands.push({ name, description, argumentHint });
      }
    }
    return commands;
  }

  private fetchAndEmitRichCommands(): void {
    const q = this.queryInstance;
    if (!q) return;
    q.supportedCommands()
      .then((commands) => {
        if (!this.alive) return; // session ended before we got results
        // Merge built-in SDK commands with custom commands from ~/.claude/commands/
        // and {cwd}/.claude/commands/. SDK built-ins win on name collision.
        const sdkNames = new Set(commands.map((c) => c.name));
        const custom = this.loadCustomCommands(this.spawnCwd).filter((c) => !sdkNames.has(c.name));
        const payload: AgendoEventPayload = {
          type: 'session:commands',
          slashCommands: [
            ...commands.map((c) => ({
              name: c.name,
              description: c.description,
              argumentHint: c.argumentHint,
            })),
            ...custom,
          ],
        };
        for (const cb of this.eventCallbacks) cb([payload]);
      })
      .catch((err) => {
        log.debug({ err }, 'supportedCommands() failed — skipping rich command enrichment');
      });
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
