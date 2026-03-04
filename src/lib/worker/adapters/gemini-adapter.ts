import { readFileSync, writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
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

/** Auto-incrementing ID for synthetic tool-use events (permission-mode flow). */
let toolUseCounter = 0;

/**
 * Extract a string message from any thrown value.
 * The SDK rejects with the raw JSON-RPC error object { code, message } (not an Error
 * instance) when the agent sends an error response. Without this helper, String(err)
 * produces "[object Object]".
 */
function extractMessage(err: unknown): string {
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
class GeminiClientHandler implements Client {
  constructor(
    private readonly emitNdjson: (event: GeminiEvent) => void,
    private readonly getApprovalHandler: () => GeminiAdapter['approvalHandler'],
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
      console.error('[gemini-adapter] approvalHandler failed, auto-allowing:', err);
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
          this.emitNdjson({ type: 'gemini:text', text: update.content.text });
        }
        break;
      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          this.emitNdjson({ type: 'gemini:thinking', text: update.content.text });
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

export class GeminiAdapter extends BaseAgentAdapter implements AgentAdapter {
  private childProcess: ReturnType<typeof BaseAgentAdapter.spawnDetached> | null = null;
  private connection: ClientSideConnection | null = null;
  private clientHandler: GeminiClientHandler | null = null;
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
  private static readonly INIT_TIMEOUT_MS = 30_000;

  /**
   * Build Gemini CLI args from SpawnOpts.
   *
   * Flags:
   *  --experimental-acp           — ACP mode (required)
   *  -m <model>                   — model override
   *  --approval-mode yolo         — skip all permission prompts when bypassPermissions
   *  --allowed-mcp-server-names   — restrict global MCP to only injected servers
   */
  private static buildArgs(opts: SpawnOpts): string[] {
    const args = ['--experimental-acp'];
    if (opts.model) {
      args.push('-m', opts.model);
    }
    const permMode = opts.permissionMode;
    if (permMode === 'bypassPermissions' || permMode === 'dontAsk') {
      args.push('--approval-mode', 'yolo');
    } else if (permMode === 'acceptEdits') {
      args.push('--approval-mode', 'auto_edit');
    } else if (permMode === 'plan') {
      args.push('--approval-mode', 'plan');
    }
    const injectedNames = (opts.mcpServers ?? []).map((s) => s.name);
    if (injectedNames.length > 0) {
      args.push('--allowed-mcp-server-names', ...injectedNames);
    } else {
      args.push('--allowed-mcp-server-names', '__none__');
    }
    args.push(...(opts.extraArgs ?? []));
    return args;
  }

  /** Create an ACP ClientSideConnection for the given child process. */
  private createConnection(
    cp: ReturnType<typeof BaseAgentAdapter.spawnDetached>,
  ): ClientSideConnection {
    if (!cp.stdin || !cp.stdout) throw new Error('Child process has no stdio');
    const stream = ndJsonStream(
      Writable.toWeb(cp.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(cp.stdout) as ReadableStream<Uint8Array>,
    );
    if (!this.clientHandler) throw new Error('clientHandler not initialized');
    const handler = this.clientHandler;
    return new ClientSideConnection((_agent) => handler, stream);
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
    // Step 1: Send ACP session/cancel notification
    if (this.sessionId && this.connection) {
      this.connection.cancel({ sessionId: this.sessionId }).catch(() => {
        // Ignore errors — process may already be exiting
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
    if (!this.sessionId || !this.connection) return false;
    // ACP mode IDs: "default", "autoEdit", "yolo".
    // "plan" is NOT a valid ACP mode (rejected with -32603).
    const modeMap: Record<string, string> = {
      default: 'default',
      acceptEdits: 'autoEdit',
      bypassPermissions: 'yolo',
      dontAsk: 'yolo',
    };
    const geminiMode = modeMap[mode];
    if (!geminiMode) return false;
    await this.connection.setSessionMode({ sessionId: this.sessionId, modeId: geminiMode });
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

    // Spawn new process with updated model
    const opts = this.storedOpts;
    const geminiArgs = GeminiAdapter.buildArgs(opts);
    const cp = BaseAgentAdapter.spawnDetached('gemini', geminiArgs, opts);
    this.childProcess = cp;

    // Wire stderr → same dataCallbacks
    cp.stderr?.on('data', (chunk: Buffer) => {
      for (const cb of this.dataCallbacks) cb(chunk.toString('utf-8'));
    });

    // Wire exit → same exitCallbacks (respecting modelSwitching flag)
    cp.on('exit', (code) => {
      if (!this.modelSwitching) {
        for (const cb of this.exitCallbacks) cb(code);
      }
    });

    // Create new ACP connection for the new process
    this.connection = this.createConnection(cp);

    // Re-initialize ACP and reload session
    try {
      const initResult = await this.acpInitialize();
      await this.loadOrCreateSession(initResult.agentCapabilities, opts, this.sessionId);
    } catch (err) {
      this.modelSwitching = false;
      const message = extractMessage(err);
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

    // Set up the client handler (shared across model-switch restarts via this.clientHandler)
    this.activeToolCalls = new Set<string>();
    this.clientHandler = new GeminiClientHandler(
      (event) => this.emitNdjson(event),
      () => this.approvalHandler,
      this.activeToolCalls,
    );

    const geminiArgs = GeminiAdapter.buildArgs(opts);
    const cp = BaseAgentAdapter.spawnDetached('gemini', geminiArgs, opts);
    this.childProcess = cp;

    // Create ACP connection
    this.connection = this.createConnection(cp);

    cp.stderr?.on('data', (chunk: Buffer) => {
      for (const cb of dataCallbacks) cb(chunk.toString('utf-8'));
    });

    let exitFired = false;
    cp.on('exit', (code) => {
      if (!exitFired && !this.modelSwitching) {
        exitFired = true;
        for (const cb of exitCallbacks) cb(code);
      }
    });

    // Async init chain — catch rejections to prevent unhandled promise crashes.
    this.currentTurn = this.initAndRun(prompt, opts, resumeSessionId).catch((err: Error) => {
      console.error('[GeminiAdapter] init failed:', err.message);
      if (!exitFired) {
        exitFired = true;
        for (const cb of exitCallbacks) cb(0);
      }
      // Kill the entire process group
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

  private async initAndRun(
    prompt: string,
    opts: SpawnOpts,
    resumeSessionId: string | null,
  ): Promise<void> {
    // 1–2: Handshake + session creation
    try {
      const initResult = await this.acpInitialize();
      await this.loadOrCreateSession(initResult.agentCapabilities, opts, resumeSessionId);
      if (!resumeSessionId && this.sessionId) {
        this.sessionRefCallback?.(this.sessionId);
      }
    } catch (err) {
      const message = extractMessage(err);
      this.emitNdjson({ type: 'gemini:turn-error', message: `Init failed: ${message}` });
      throw err;
    }

    // Emit init event with model and sessionId
    if (this.sessionId && opts.model) {
      this.emitNdjson({ type: 'gemini:init', model: opts.model, sessionId: this.sessionId });
    }

    // 3. First prompt
    await this.sendPrompt(prompt);
  }

  /**
   * Send ACP initialize with retry on 429.
   * Timeout: 30s per attempt.
   */
  private async acpInitialize(
    attempt = 1,
  ): Promise<Awaited<ReturnType<ClientSideConnection['initialize']>>> {
    if (!this.connection) throw new Error('No ACP connection');
    const timeoutMs = GeminiAdapter.INIT_TIMEOUT_MS;
    try {
      return await Promise.race([
        this.connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'agendo', version: '1.0.0' },
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`ACP initialize timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    } catch (err) {
      const message = extractMessage(err);
      const isRetryable =
        (message.includes('429') || message.includes('Rate limit exceeded')) && attempt < 3;
      if (isRetryable) {
        const delay = Math.pow(2, attempt) * 2000; // 4s, 8s
        console.warn(`[GeminiAdapter] initialize failed with 429, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        return this.acpInitialize(attempt + 1);
      }
      throw err;
    }
  }

  /**
   * Load an existing session (via session/load) or create a new one (via session/new).
   */
  private async loadOrCreateSession(
    agentCaps: { loadSession?: boolean } | undefined,
    opts: SpawnOpts,
    resumeSessionId: string | null,
  ): Promise<void> {
    if (!this.connection) throw new Error('No ACP connection');

    if (resumeSessionId && agentCaps?.loadSession) {
      try {
        await this.connection.loadSession({
          sessionId: resumeSessionId,
          cwd: opts.cwd,
          mcpServers: (opts.mcpServers ?? []) as Parameters<
            ClientSideConnection['loadSession']
          >[0]['mcpServers'],
        });
        return; // session/load succeeded
      } catch (loadErr) {
        const msg = extractMessage(loadErr);
        console.warn(`[GeminiAdapter] session/load failed, falling back to session/new: ${msg}`);
      }
    }

    const result = await this.connection.newSession({
      cwd: opts.cwd,
      mcpServers: (opts.mcpServers ?? []) as Parameters<
        ClientSideConnection['newSession']
      >[0]['mcpServers'],
    });
    this.sessionId = result.sessionId;
  }

  private async sendPrompt(text: string): Promise<void> {
    if (!this.sessionId || !this.connection) throw new Error('No active session');
    this.thinkingCallback?.(true);

    // Build prompt content blocks — text always present, image optional
    const promptContent: Parameters<ClientSideConnection['prompt']>[0]['prompt'] = [
      { type: 'text', text },
    ];
    if (this.pendingImage) {
      promptContent.push({
        type: 'image',
        data: this.pendingImage.data,
        mimeType: this.pendingImage.mimeType,
      } as (typeof promptContent)[number]);
      this.pendingImage = null;
    }

    try {
      const conn = this.connection;
      const timeoutMs = GeminiAdapter.PROMPT_TIMEOUT_MS;
      await Promise.race([
        conn.prompt({ sessionId: this.sessionId, prompt: promptContent }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`ACP session/prompt timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ]);
      // Emit synthetic result event so session-process emits agent:result
      this.emitNdjson({ type: 'gemini:turn-complete', result: {} });
    } catch (err) {
      const message = extractMessage(err);
      // Don't emit error for process exit — onExit handles that
      if (!message.includes('Gemini process exited') && !message.includes('Connection closed')) {
        this.emitNdjson({ type: 'gemini:turn-error', message });
      }
      throw err;
    } finally {
      this.thinkingCallback?.(false);
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
}
