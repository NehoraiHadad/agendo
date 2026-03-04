import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AsyncLock } from '@/lib/utils/async-lock';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { mapGeminiJsonToEvents, type GeminiEvent } from '@/lib/worker/adapters/gemini-event-mapper';
import type {
  AgentAdapter,
  ImageContent,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';
import { BaseAgentAdapter } from '@/lib/worker/adapters/base-adapter';

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

export class GeminiAdapter extends BaseAgentAdapter implements AgentAdapter {
  private childProcess: ReturnType<typeof BaseAgentAdapter.spawnDetached> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private sessionId: string | null = null;
  private currentTurn: Promise<void> = Promise.resolve();
  private lock = new AsyncLock();
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
  /** Active tool call IDs from `tool_call` events (yolo mode).
   *  Used to pair `tool_call_update` with its start event and avoid
   *  emitting orphaned tool-end events in default mode (where tools are
   *  tracked via the permission handler instead). */
  private activeToolCalls = new Set<string>();

  /** Timeout for session/prompt ACP requests (10 minutes). */
  static readonly PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;

  /**
   * Build Gemini CLI args from SpawnOpts. Centralized so launch() and setModel()
   * restart use the same flags.
   *
   * Flags:
   *  --experimental-acp           — ACP mode (required)
   *  -m <model>                   — model override
   *  --approval-mode yolo         — skip all permission prompts when bypassPermissions
   *  --allowed-mcp-server-names   — restrict global MCP to only injected servers (avoid
   *                                 loading 6+ global MCP servers from ~/.gemini/settings.json)
   */
  private static buildArgs(opts: SpawnOpts): string[] {
    const args = ['--experimental-acp'];
    if (opts.model) {
      args.push('-m', opts.model);
    }
    // Map Agendo permission mode to Gemini --approval-mode.
    // bypassPermissions/dontAsk → yolo (suppresses ALL ACP permission requests)
    // acceptEdits → auto_edit (auto-approve file edits, prompt for shell)
    // plan → plan (read-only enforcement; requires experimental.plan=true in settings.json)
    const permMode = opts.permissionMode;
    if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
      args.push('--approval-mode', 'yolo');
    } else if (permMode === 'acceptEdits') {
      args.push('--approval-mode', 'auto_edit');
    } else if (permMode === 'plan') {
      args.push('--approval-mode', 'plan');
    }
    // Restrict global MCP servers: only load servers injected via ACP session/new.
    // Pass the names of injected servers so they are not filtered out by the allowlist.
    const injectedNames = (opts.mcpServers ?? []).map((s) => s.name);
    if (injectedNames.length > 0) {
      args.push('--allowed-mcp-server-names', ...injectedNames);
    } else {
      // No MCP servers injected — block all global servers to avoid slow startup
      args.push('--allowed-mcp-server-names', '__none__');
    }
    args.push(...(opts.extraArgs ?? []));
    return args;
  }

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

  async setPermissionMode(mode: string): Promise<boolean> {
    if (!this.sessionId) return false;
    // ACP mode IDs from session/new response: "default", "autoEdit", "yolo".
    // "plan" is NOT a valid ACP mode (rejected with -32603).
    const modeMap: Record<string, string> = {
      default: 'default',
      acceptEdits: 'autoEdit',
      bypassPermissions: 'yolo',
      dontAsk: 'yolo',
    };
    const geminiMode = modeMap[mode];
    if (!geminiMode) return false;
    await this.sendRequest('session/set_mode', {
      sessionId: this.sessionId,
      modeId: geminiMode,
    });
    return true;
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
    const geminiArgs = GeminiAdapter.buildArgs(opts);

    const cp = BaseAgentAdapter.spawnDetached('gemini', geminiArgs, opts);
    this.childProcess = cp;

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

      await this.loadOrCreateSession(initResult?.agentCapabilities, opts, this.sessionId);
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

    const geminiArgs = GeminiAdapter.buildArgs(opts);

    const cp = BaseAgentAdapter.spawnDetached('gemini', geminiArgs, opts);
    this.childProcess = cp;

    // Parse ndJSON from stdout line by line (readline handles buffering — no processLineBuffer needed)
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
      // Use SIGKILL fallback because Gemini may ignore SIGTERM during init.
      if (cp.pid) {
        try {
          process.kill(-cp.pid, 'SIGTERM');
        } catch {
          try {
            cp.kill('SIGTERM');
          } catch {
            /* already dead */
          }
        }
        // SIGKILL fallback after 2s — Gemini sometimes ignores SIGTERM
        const pid = cp.pid;
        setTimeout(() => {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }, 2000);
      } else {
        cp.kill('SIGKILL');
      }
    });

    return {
      pid: cp.pid ?? 0,
      tmuxSession: '',
      stdin: null,
      kill: BaseAgentAdapter.buildKill(() => this.childProcess),
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
        // ACP permission options: allow_always (session-wide), allow_once, reject_once.
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
          // Auto-allow: prefer allow_always (session-wide) so subsequent calls skip prompting
          const allowOption =
            options.find((o) => o.kind === 'allow_always') ??
            options.find((o) => o.kind === 'allow_once') ??
            options[0];
          this.writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            result: { outcome: { outcome: 'selected', optionId: allowOption?.optionId ?? '' } },
          });
          this.emitNdjson({ type: 'gemini:tool-end', toolUseId });
          return;
        }

        const approvalId = String(msg.id);
        const msgId = msg.id;
        this.approvalHandler({ approvalId, toolName, toolInput })
          .then((decision) => {
            let chosenOption;
            if (decision === 'deny') {
              chosenOption =
                options.find((o) => o.kind === 'reject_once') ?? options[options.length - 1];
            } else if (decision === 'allow-session') {
              // Session-wide approval → use allow_always so Gemini won't ask again for this tool
              chosenOption =
                options.find((o) => o.kind === 'allow_always') ??
                options.find((o) => o.kind === 'allow_once') ??
                options[0];
            } else {
              // 'allow' or { behavior: 'allow', updatedInput } → one-time approval
              chosenOption = options.find((o) => o.kind === 'allow_once') ?? options[0];
            }
            this.writeJson({
              jsonrpc: '2.0',
              id: msgId,
              result: { outcome: { outcome: 'selected', optionId: chosenOption?.optionId ?? '' } },
            });
            this.emitNdjson({ type: 'gemini:tool-end', toolUseId });
          })
          .catch((err: unknown) => {
            console.error('[gemini-adapter] approvalHandler failed, auto-allowing:', err);
            const allowOption =
              options.find((o) => o.kind === 'allow_always') ??
              options.find((o) => o.kind === 'allow_once') ??
              options[0];
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
        } else if (sessionUpdate === 'tool_call') {
          // Yolo mode: tool_call (status=in_progress) → tool started.
          // Default mode uses session/request_permission instead (handled above).
          const toolCallId = update?.toolCallId as string | undefined;
          const title = (update?.title as string) ?? '';
          const kind = (update?.kind as string) ?? '';
          const locations = (update?.locations as Array<{ path?: string }>) ?? [];
          const filePath = locations[0]?.path;
          // Extract actual tool name from toolCallId (format: "tool_name-timestamp")
          // Fall back to title if toolCallId doesn't contain a recognizable name.
          const extractedName = toolCallId?.replace(/-\d+$/, '') ?? '';
          // Use title as description context (for shell commands it contains the command)
          // but use extractedName as the primary tool name.
          // Title can be "{}" or raw JSON for MCP tools, so prefer extractedName.
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
        } else if (sessionUpdate === 'tool_call_update') {
          // Sent in both yolo and default modes when a tool completes or fails.
          // In yolo mode: paired with a preceding tool_call → close it.
          // In default mode: no preceding tool_call (permission handler handled
          // the start+end) → skip to avoid orphaned tool-end events.
          const toolCallId = update?.toolCallId as string | undefined;
          if (toolCallId && this.activeToolCalls.has(toolCallId)) {
            this.activeToolCalls.delete(toolCallId);
            // Extract result content from tool_call_update payload
            const contentArr = (update?.content as Array<{ content?: { text?: string } }>) ?? [];
            const resultText = contentArr
              .map((c) => c.content?.text ?? '')
              .filter(Boolean)
              .join('\n');
            const status = update?.status as string | undefined;
            this.emitNdjson({
              type: 'gemini:tool-end',
              toolUseId: toolCallId,
              ...(resultText ? { resultText } : {}),
              ...(status === 'failed' ? { failed: true } : {}),
            });
          }
          // else: default mode — permission handler already emitted start+end
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

      await this.loadOrCreateSession(initResult?.agentCapabilities, opts, resumeSessionId);
      if (!resumeSessionId && this.sessionId) {
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

  /**
   * Load an existing session (via session/load) or create a new one (via session/new).
   *
   * - If resumeSessionId is provided and the adapter supports loadSession:
   *   tries session/load first; falls back to session/new on failure.
   * - Otherwise (or on fallback): calls session/new and updates this.sessionId.
   *
   * Note: sessionRefCallback is NOT called here — callers are responsible for
   * invoking it when a brand-new (non-resume) session is started.
   */
  private async loadOrCreateSession(
    agentCaps: Record<string, unknown> | undefined,
    opts: SpawnOpts,
    resumeSessionId: string | null,
  ): Promise<void> {
    if (resumeSessionId && agentCaps?.loadSession) {
      try {
        await this.sendRequest('session/load', {
          sessionId: resumeSessionId,
          cwd: opts.cwd,
          mcpServers: opts.mcpServers ?? [],
        });
        return; // session/load succeeded; this.sessionId already points to the resumed session
      } catch (loadErr) {
        const msg = loadErr instanceof Error ? loadErr.message : String(loadErr);
        console.warn(`[GeminiAdapter] session/load failed, falling back to session/new: ${msg}`);
      }
    }

    const result = await this.sendRequest<{ sessionId: string }>('session/new', {
      cwd: opts.cwd,
      mcpServers: opts.mcpServers ?? [],
    });
    this.sessionId = result.sessionId;
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

  private async sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    attempt = 1,
  ): Promise<T> {
    const id = ++this.requestId;
    try {
      const response = await new Promise<T>((resolve, reject) => {
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
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isRetryable =
        GeminiAdapter.INIT_METHODS.has(method) &&
        (message.includes('429') || message.includes('Rate limit exceeded')) &&
        attempt < 3;

      if (isRetryable) {
        const delay = Math.pow(2, attempt) * 2000; // 4s, 8s
        console.warn(`[GeminiAdapter] ${method} failed with 429, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        return this.sendRequest<T>(method, params, attempt + 1);
      }
      throw err;
    }
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
