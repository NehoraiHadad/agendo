import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AsyncLock } from '@/lib/utils/async-lock';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { mapGeminiJsonToEvents, type GeminiEvent } from '@/lib/worker/adapters/gemini-event-mapper';
import type {
  AgentAdapter,
  ApprovalHandler,
  ImageContent,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface AcpMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Auto-incrementing ID for synthetic tool-use events. */
let toolUseCounter = 0;

export class GeminiAdapter implements AgentAdapter {
  private childProcess: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private sessionId: string | null = null;
  private currentTurn: Promise<void> = Promise.resolve();
  private lock = new AsyncLock();
  private thinkingCallback: ((thinking: boolean) => void) | null = null;
  private approvalHandler: ApprovalHandler | null = null;
  private sessionRefCallback: ((ref: string) => void) | null = null;
  /** Stored image for the next sendPrompt call. */
  private pendingImage: ImageContent | null = null;
  /** Data callbacks from the ManagedProcess — used to emit synthetic NDJSON. */
  private dataCallbacks: Array<(chunk: string) => void> = [];
  /** Exit callbacks from the ManagedProcess — stored for model-switch re-wiring. */
  private exitCallbacks: Array<(code: number | null) => void> = [];
  /** Spawn opts stored for process restart during model switch. */
  private storedOpts: SpawnOpts | null = null;
  /** When true, suppresses exit callbacks during model-switch process restart. */
  private modelSwitching = false;

  /** Timeout for session/prompt ACP requests (10 minutes). */
  static readonly PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    return this.launch(prompt, opts, null);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.sessionId = sessionRef;
    return this.launch(prompt, opts, sessionRef);
  }

  extractSessionId(_output: string): string | null {
    return this.sessionId;
  }

  async sendMessage(message: string, image?: ImageContent): Promise<void> {
    if (!this.sessionId) throw new Error('No active Gemini ACP session');
    await this.currentTurn;
    this.pendingImage = image ?? null;
    this.currentTurn = this.lock.acquire(() => this.sendPrompt(message));
    await this.currentTurn;
  }

  async interrupt(): Promise<void> {
    // Step 1: Send ACP session/cancel notification (per spec — no id, it's a notification)
    if (this.sessionId) {
      this.writeJson({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: this.sessionId },
      });
    }

    // Step 2: Wait 2s, then SIGINT
    await new Promise<void>((r) => setTimeout(r, 2000));
    if (!this.isAlive()) return;
    if (this.childProcess?.pid) {
      try {
        process.kill(-this.childProcess.pid, 'SIGINT');
      } catch {
        // Process group already dead
      }
    }

    // Step 3: Wait 2s, then SIGTERM (escalation)
    await new Promise<void>((r) => setTimeout(r, 2000));
    if (!this.isAlive()) return;
    if (this.childProcess?.pid) {
      try {
        process.kill(-this.childProcess.pid, 'SIGTERM');
      } catch {
        // Process group already dead
      }
    }

    // Step 4: Wait 5s, then SIGKILL (final escalation)
    await new Promise<void>((r) => setTimeout(r, 5000));
    if (!this.isAlive()) return;
    if (this.childProcess?.pid) {
      try {
        process.kill(-this.childProcess.pid, 'SIGKILL');
      } catch {
        // Process group already dead
      }
    }
  }

  isAlive(): boolean {
    return this.childProcess?.stdin?.writable ?? false;
  }

  onThinkingChange(cb: (thinking: boolean) => void): void {
    this.thinkingCallback = cb;
  }

  setApprovalHandler(handler: ApprovalHandler): void {
    this.approvalHandler = handler;
  }

  onSessionRef(cb: (ref: string) => void): void {
    this.sessionRefCallback = cb;
  }

  async setModel(model: string): Promise<boolean> {
    if (!this.storedOpts || !this.sessionId) return false;

    this.modelSwitching = true;
    this.storedOpts = { ...this.storedOpts, model };

    // Kill the old process group and wait for it to exit
    const oldCp = this.childProcess;
    if (oldCp?.pid) {
      const exitPromise = new Promise<void>((resolve) => {
        oldCp.once('exit', () => resolve());
      });
      try {
        process.kill(-oldCp.pid, 'SIGTERM');
      } catch {
        // Already dead
      }
      await exitPromise;
    }

    // Reject all pending requests from the old process
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Gemini process restarting for model switch'));
    }
    this.pendingRequests.clear();

    // Spawn new process with updated model
    const opts = this.storedOpts;
    const geminiArgs = ['--experimental-acp'];
    if (opts.model) {
      geminiArgs.push('-m', opts.model);
    }
    geminiArgs.push(...(opts.extraArgs ?? []));

    const cp = nodeSpawn('gemini', geminiArgs, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    this.childProcess = cp;
    cp.unref();

    // Wire new stdout to readline parser → same dataCallbacks
    const rl = createInterface({ input: cp.stdout ?? process.stdin });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return;
      try {
        const msg = JSON.parse(trimmed) as AcpMessage;
        this.handleAcpMessage(msg, this.dataCallbacks);
      } catch {
        // Skip non-JSON lines
      }
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      for (const cb of this.dataCallbacks) cb(chunk.toString('utf-8'));
    });

    // Wire exit handler to same exitCallbacks (respecting modelSwitching flag)
    cp.on('exit', (code) => {
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Gemini process exited'));
      }
      this.pendingRequests.clear();
      if (!this.modelSwitching) {
        for (const cb of this.exitCallbacks) cb(code);
      }
    });

    // Re-initialize ACP and reload session
    try {
      const initResult = await this.sendRequest<{ agentCapabilities?: Record<string, unknown> }>(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'agendo', version: '1.0.0' },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        },
      );

      const supportsLoad = !!(initResult?.agentCapabilities as Record<string, unknown> | undefined)
        ?.loadSession;
      if (supportsLoad) {
        await this.sendRequest('session/load', {
          sessionId: this.sessionId,
          cwd: opts.cwd,
          mcpServers: opts.mcpServers ?? [],
        });
      } else {
        // loadSession not supported — create a fresh session in the new process
        const result = await this.sendRequest<{ sessionId: string }>('session/new', {
          cwd: opts.cwd,
          mcpServers: opts.mcpServers ?? [],
        });
        this.sessionId = result.sessionId;
      }
    } catch (err) {
      this.modelSwitching = false;
      const message = err instanceof Error ? err.message : String(err);
      this.emitNdjson({ type: 'gemini:turn-error', message: `Model switch failed: ${message}` });
      return false;
    }

    this.modelSwitching = false;
    return true;
  }

  mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    return mapGeminiJsonToEvents(parsed as GeminiEvent);
  }

  private launch(prompt: string, opts: SpawnOpts, resumeSessionId: string | null): ManagedProcess {
    this.storedOpts = opts;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];
    this.dataCallbacks = dataCallbacks;
    this.exitCallbacks = exitCallbacks;

    const geminiArgs = ['--experimental-acp'];
    if (opts.model) {
      geminiArgs.push('-m', opts.model);
    }
    geminiArgs.push(...(opts.extraArgs ?? []));

    const cp = nodeSpawn('gemini', geminiArgs, {
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    this.childProcess = cp;
    cp.unref();

    // Parse ndJSON from stdout line by line
    const rl = createInterface({ input: cp.stdout ?? process.stdin });
    rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return;
      try {
        const msg = JSON.parse(trimmed) as AcpMessage;
        this.handleAcpMessage(msg, dataCallbacks);
      } catch {
        // Skip non-JSON lines (Gemini debug output)
      }
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      for (const cb of dataCallbacks) cb(chunk.toString('utf-8'));
    });

    let exitFired = false;

    cp.on('exit', (code) => {
      // Reject all pending requests so awaiting callers unblock
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('Gemini process exited'));
      }
      this.pendingRequests.clear();
      if (!exitFired && !this.modelSwitching) {
        exitFired = true;
        for (const cb of exitCallbacks) cb(code);
      }
    });

    // Async init chain — catch rejections to prevent unhandled promise crashes.
    // Error events are already emitted by initAndRun (for init failures) or
    // sendPrompt (for prompt failures). Here we just clean up: exit with code 0
    // so session-process transitions to 'idle' (resumable) instead of showing
    // the "Session ended unexpectedly" message.
    this.currentTurn = this.initAndRun(prompt, opts, resumeSessionId).catch((err: Error) => {
      console.error('[GeminiAdapter] init failed:', err.message);
      if (!exitFired) {
        exitFired = true;
        for (const cb of exitCallbacks) cb(0);
      }
      // Kill the entire process group (not just the main process) — Gemini CLI
      // spawns with detached:true, so cp.kill() alone leaves orphan children.
      if (cp.pid) {
        try {
          process.kill(-cp.pid, 'SIGTERM');
        } catch {
          cp.kill();
        }
      } else {
        cp.kill();
      }
    });

    return {
      pid: cp.pid ?? 0,
      tmuxSession: '',
      stdin: null,
      kill: (signal) => {
        const p = this.childProcess;
        if (!p?.pid) return;
        try {
          process.kill(-p.pid, signal);
        } catch {
          // Process group already dead
        }
      },
      onData: (cb) => dataCallbacks.push(cb),
      onExit: (cb) => exitCallbacks.push(cb),
    };
  }

  private handleAcpMessage(msg: AcpMessage, _dataCallbacks: Array<(chunk: string) => void>): void {
    // Response to one of our requests (has id + result or error, no method)
    if (msg.id !== undefined && !msg.method && ('result' in msg || 'error' in msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Server request (has id + method → needs a response)
    if (msg.id !== undefined && msg.method) {
      if (msg.method === 'session/request_permission') {
        // ACP v0.20 schema: params = { sessionId, toolCall, options: [{ kind, name, optionId }] }
        // "allow_once" kind → first option with kind=allow_once, "reject_once" → reject
        const params = msg.params ?? {};
        const toolCall = params.toolCall as Record<string, unknown> | undefined;
        const options =
          (params.options as Array<{ kind: string; optionId: string; name: string }>) ?? [];

        const toolName = (toolCall?.title as string | undefined) ?? 'unknown';
        const toolInput = (toolCall?.rawInput as Record<string, unknown>) ?? {};
        const toolUseId = `gemini-tool-${++toolUseCounter}`;

        // Emit tool-start NDJSON so the frontend shows the tool card
        this.emitNdjson({ type: 'gemini:tool-start', toolName, toolInput, toolUseId });

        if (!this.approvalHandler) {
          // Auto-allow: pick the first allow_once option
          const allowOption = options.find((o) => o.kind === 'allow_once') ?? options[0];
          this.writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            // ACP requestPermissionResponseSchema: { outcome: { outcome: 'selected', optionId } }
            result: { outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? '' } },
          });
          // Emit tool-end after approval
          this.emitNdjson({ type: 'gemini:tool-end', toolUseId });
          return;
        }

        const approvalId = String(msg.id);
        const msgId = msg.id;
        this.approvalHandler({ approvalId, toolName, toolInput, isAskUser: false })
          .then((decision) => {
            const chosenOption =
              decision === 'deny'
                ? (options.find((o) => o.kind === 'reject_once') ?? options[options.length - 1])
                : (options.find((o) => o.kind === 'allow_once') ?? options[0]);
            this.writeJson({
              jsonrpc: '2.0',
              id: msgId,
              // ACP requestPermissionResponseSchema: { outcome: { outcome: 'selected', optionId } }
              result: { outcome: { outcome: 'selected', optionId: chosenOption?.optionId ?? '' } },
            });
            // Emit tool-end after approval response
            this.emitNdjson({ type: 'gemini:tool-end', toolUseId });
          })
          .catch((err: unknown) => {
            console.error('[gemini-adapter] approvalHandler failed, auto-allowing:', err);
            const allowOption = options.find((o) => o.kind === 'allow_once') ?? options[0];
            this.writeJson({
              jsonrpc: '2.0',
              id: msgId,
              result: { outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? '' } },
            });
            this.emitNdjson({ type: 'gemini:tool-end', toolUseId });
          });
      }
      // Handle fs/read_text_file and fs/write_text_file client requests from Gemini
      // Per ACP spec: params include sessionId, path, line?, limit?
      else if (msg.method === 'fs/read_text_file') {
        const {
          path: filePath,
          line,
          limit,
        } = msg.params as { sessionId: string; path: string; line?: number; limit?: number };
        try {
          let content = readFileSync(filePath, 'utf-8');
          if (line !== undefined && line !== null) {
            const lines = content.split('\n');
            const start = Math.max(0, line - 1);
            const end = limit ? start + limit : lines.length;
            content = lines.slice(start, end).join('\n');
          }
          this.writeJson({ jsonrpc: '2.0', id: msg.id, result: { content } });
        } catch {
          this.writeJson({ jsonrpc: '2.0', id: msg.id, result: { content: '' } });
        }
      } else if (msg.method === 'fs/write_text_file') {
        const { path: filePath, content } = msg.params as {
          sessionId: string;
          path: string;
          content: string;
        };
        try {
          writeFileSync(filePath, content, 'utf-8');
        } catch {
          /* ignore write errors */
        }
        this.writeJson({ jsonrpc: '2.0', id: msg.id, result: null });
      }
      return;
    }

    // Notification (no id, has method)
    // ACP v0.20: session/update params = { sessionId, update: { sessionUpdate, content, ... } }
    if (msg.method && msg.id === undefined) {
      if (msg.method === 'session/update') {
        const update = msg.params?.update as Record<string, unknown> | undefined;
        const sessionUpdate = update?.sessionUpdate as string | undefined;
        if (sessionUpdate === 'agent_message_chunk') {
          const content = update?.content as Record<string, unknown> | undefined;
          if (content?.type === 'text' && typeof content.text === 'string') {
            // Emit structured NDJSON instead of raw text
            this.emitNdjson({ type: 'gemini:text', text: content.text });
          }
        } else if (sessionUpdate === 'agent_thought_chunk') {
          const content = update?.content as Record<string, unknown> | undefined;
          if (content?.type === 'text' && typeof content.text === 'string') {
            // Emit structured NDJSON for thinking output
            this.emitNdjson({ type: 'gemini:thinking', text: content.text });
          }
        } else if (sessionUpdate === 'tool_call_start') {
          const toolCall = update?.toolCall as Record<string, unknown> | undefined;
          const toolUseId = `gemini-tool-${++toolUseCounter}`;
          this.emitNdjson({
            type: 'gemini:tool-start',
            toolName: (toolCall?.title as string) ?? (toolCall?.name as string) ?? 'unknown',
            toolInput:
              (toolCall?.rawInput as Record<string, unknown>) ??
              (toolCall?.input as Record<string, unknown>) ??
              {},
            toolUseId,
          });
        } else if (sessionUpdate === 'tool_call_end' || sessionUpdate === 'tool_result') {
          this.emitNdjson({ type: 'gemini:tool-end', toolUseId: `gemini-tool-${toolUseCounter}` });
        }
      }
    }
  }

  private async initAndRun(
    prompt: string,
    opts: SpawnOpts,
    resumeSessionId: string | null,
  ): Promise<void> {
    // 1–2: Handshake + session creation.
    // Errors here are init failures (sendPrompt was never called), so we emit
    // the error event here. sendPrompt handles its own errors separately.
    try {
      const initResult = await this.sendRequest<{ agentCapabilities?: Record<string, unknown> }>(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'agendo', version: '1.0.0' },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        },
      );

      if (resumeSessionId) {
        // session/load: resume an existing session (requires loadSession capability)
        const supportsLoad = !!(
          initResult?.agentCapabilities as Record<string, unknown> | undefined
        )?.loadSession;
        if (supportsLoad) {
          await this.sendRequest('session/load', {
            sessionId: resumeSessionId,
            cwd: opts.cwd,
            mcpServers: opts.mcpServers ?? [],
          });
        } else {
          // loadSession not supported — the old sessionId is invalid in this new
          // process. Create a fresh session so session/prompt has a valid target.
          const result = await this.sendRequest<{ sessionId: string }>('session/new', {
            cwd: opts.cwd,
            mcpServers: opts.mcpServers ?? [],
          });
          this.sessionId = result.sessionId;
        }
      } else {
        const result = await this.sendRequest<{ sessionId: string }>('session/new', {
          cwd: opts.cwd,
          mcpServers: opts.mcpServers ?? [],
        });
        this.sessionId = result.sessionId;
        this.sessionRefCallback?.(this.sessionId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emitNdjson({ type: 'gemini:turn-error', message: `Init failed: ${message}` });
      throw err;
    }

    // Emit init event with model and sessionId so the frontend can display them.
    if (this.sessionId && opts.model) {
      this.emitNdjson({ type: 'gemini:init', model: opts.model, sessionId: this.sessionId });
    }

    // 3. First prompt — sendPrompt emits its own error events on failure.
    await this.sendPrompt(prompt);
  }

  private async sendPrompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session');
    this.thinkingCallback?.(true);

    // Build prompt content blocks — text always present, image optional
    const promptContent: Array<Record<string, unknown>> = [{ type: 'text', text }];
    if (this.pendingImage) {
      promptContent.push({
        type: 'image',
        data: this.pendingImage.data,
        mimeType: this.pendingImage.mimeType,
      });
      this.pendingImage = null;
    }

    try {
      // Send directly — do NOT retry session/prompt. Gemini's ACP server
      // appends the message to conversation history BEFORE calling the API,
      // so retrying on 429 causes duplicate messages in the chat context.
      // The error surfaces to the user, who can resend from the UI.
      const result = await this.sendRequest<Record<string, unknown>>('session/prompt', {
        sessionId: this.sessionId,
        prompt: promptContent,
      });
      // Emit synthetic result event so session-process emits agent:result
      this.emitNdjson({ type: 'gemini:turn-complete', result: result ?? {} });
    } catch (err) {
      // Emit error event so session-process transitions to awaiting_input
      const message = err instanceof Error ? err.message : String(err);
      // Don't emit error for process exit — onExit handles that
      if (!message.includes('Gemini process exited')) {
        this.emitNdjson({ type: 'gemini:turn-error', message });
      }
      // Re-throw so the lock.acquire caller can handle it if needed
      throw err;
    } finally {
      this.thinkingCallback?.(false);
    }
  }

  /**
   * ACP request timeout for handshake/init methods (initialize, session/new).
   * session/prompt also gets a timeout (PROMPT_TIMEOUT_MS) to prevent hanging
   * indefinitely if Gemini crashes mid-turn without closing stdout.
   */
  private static readonly INIT_METHODS = new Set(['initialize', 'session/new']);
  private static readonly INIT_TIMEOUT_MS = 30_000;

  private sendRequest<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.writeJson({ jsonrpc: '2.0', id, method, params });

      // Determine timeout based on method type
      let timeoutMs: number | null = null;
      if (GeminiAdapter.INIT_METHODS.has(method)) {
        timeoutMs = GeminiAdapter.INIT_TIMEOUT_MS;
      } else if (method === 'session/prompt') {
        timeoutMs = GeminiAdapter.PROMPT_TIMEOUT_MS;
      }

      if (timeoutMs !== null) {
        const ms = timeoutMs;
        setTimeout(() => {
          if (this.pendingRequests.has(id)) {
            this.pendingRequests.delete(id);
            reject(new Error(`ACP request "${method}" timed out after ${ms}ms`));
          }
        }, ms);
      }
    });
  }

  /**
   * Emit a synthetic NDJSON line to all dataCallbacks. session-process.ts
   * parses these through the standard NDJSON pipeline and delegates to
   * mapJsonToEvents (gemini-event-mapper.ts).
   */
  private emitNdjson(event: GeminiEvent): void {
    const line = JSON.stringify(event) + '\n';
    for (const cb of this.dataCallbacks) cb(line);
  }

  private writeJson(msg: Record<string, unknown>): void {
    if (!this.childProcess?.stdin?.writable) return;
    this.childProcess.stdin.write(JSON.stringify(msg) + '\n');
  }
}
