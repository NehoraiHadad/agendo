import { createLogger } from '@/lib/logger';

const log = createLogger('copilot-adapter');
import { AsyncLock } from '@/lib/utils/async-lock';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import {
  mapCopilotJsonToEvents,
  type CopilotEvent,
} from '@/lib/worker/adapters/copilot-event-mapper';
import { extractMessage, CopilotClientHandler } from '@/lib/worker/adapters/copilot-client-handler';
import { AcpTransport } from '@/lib/worker/adapters/gemini-acp-transport';
import type {
  AgentAdapter,
  ImageContent,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';
import { BaseAgentAdapter } from '@/lib/worker/adapters/base-adapter';

export class CopilotAdapter extends BaseAgentAdapter implements AgentAdapter {
  private childProcess: ReturnType<typeof BaseAgentAdapter.spawnDetached> | null = null;
  private transport = new AcpTransport();
  private clientHandler: CopilotClientHandler | null = null;
  private sessionId: string | null = null;
  private currentTurn: Promise<void> = Promise.resolve();
  private lock = new AsyncLock();
  /** Stored image for the next sendPrompt call. */
  private pendingImage: ImageContent | null = null;
  /** Data callbacks from the ManagedProcess — used to emit synthetic NDJSON. */
  private dataCallbacks: Array<(chunk: string) => void> = [];
  /** Exit callbacks from the ManagedProcess — stored for re-wiring. */
  private exitCallbacks: Array<(code: number | null) => void> = [];
  /** Spawn opts stored for reference. */
  private storedOpts: SpawnOpts | null = null;
  /** Active tool call IDs from `tool_call` events (yolo mode).
   *  Used to pair `tool_call_update` with its start event and avoid
   *  emitting orphaned tool-end events in default mode (where tools are
   *  tracked via the permission handler instead). */
  private activeToolCalls = new Set<string>();

  /** Timeout for session/prompt ACP requests (10 minutes). */
  static readonly PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;

  /**
   * Build Copilot CLI args from SpawnOpts.
   *
   * Flags:
   *  --acp                        — ACP mode (required)
   *  --no-auto-update             — disable auto-update
   *  --disable-builtin-mcps       — disable builtin MCP servers
   *  --yolo                       — skip all permission prompts when bypassPermissions
   *  --allow-all-tools --allow-all-paths — for acceptEdits/plan modes
   *  --model <model>              — model override
   *  --resume=<id>                — resume a previous session
   *  --additional-mcp-config      — MCP server configuration JSON
   */
  private static buildArgs(
    opts: SpawnOpts,
    isResume: boolean,
    sessionRef: string | null,
  ): string[] {
    const args = ['--acp', '--no-auto-update', '--disable-builtin-mcps'];

    if (opts.permissionMode === 'bypassPermissions' || opts.permissionMode === 'dontAsk') {
      args.push('--yolo');
    } else if (opts.permissionMode === 'acceptEdits' || opts.permissionMode === 'plan') {
      args.push('--allow-all-tools', '--allow-all-paths');
    }

    if (opts.model) args.push('--model', opts.model);

    if (opts.sessionId) args.push(`--resume=${opts.sessionId}`);
    else if (isResume && sessionRef) args.push(`--resume=${sessionRef}`);

    if (opts.mcpServers?.length) {
      const config: Record<string, unknown> = {};
      for (const srv of opts.mcpServers) {
        config[srv.name] = {
          command: srv.command,
          args: srv.args,
          env: Object.fromEntries(srv.env.map(({ name, value }) => [name, value])),
        };
      }
      args.push('--additional-mcp-config', JSON.stringify({ mcpServers: config }));
    }

    args.push(...(opts.extraArgs ?? []));
    return args;
  }

  /** Create an ACP connection for the given child process via the transport. */
  private createTransportConnection(cp: ReturnType<typeof BaseAgentAdapter.spawnDetached>): void {
    if (!cp.stdin || !cp.stdout) throw new Error('Child process has no stdio');
    if (!this.clientHandler) throw new Error('clientHandler not initialized');
    this.transport.createConnection(
      cp.stdin as NodeJS.WritableStream,
      cp.stdout as NodeJS.ReadableStream,
      this.clientHandler,
    );
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

  async sendMessage(
    message: string,
    image?: ImageContent,
    _priority?: import('@/lib/realtime/events').MessagePriority,
  ): Promise<void> {
    if (!this.sessionId) throw new Error('No active Copilot ACP session');
    await this.currentTurn;
    this.pendingImage = image ?? null;
    this.currentTurn = this.lock.acquire(() => this.sendPrompt(message));
    await this.currentTurn;
  }

  async interrupt(): Promise<void> {
    // Step 1: Send ACP session/cancel notification
    const conn = this.transport.getConnection();
    if (this.sessionId && conn) {
      conn.cancel({ sessionId: this.sessionId }).catch(() => {
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
    const conn = this.transport.getConnection();
    if (!this.sessionId || !conn) return false;
    // ACP mode IDs: "default", "autoEdit", "yolo".
    const modeMap: Record<string, string> = {
      default: 'default',
      acceptEdits: 'autoEdit',
      bypassPermissions: 'yolo',
      dontAsk: 'yolo',
    };
    const copilotMode = modeMap[mode];
    if (!copilotMode) return false;
    await conn.setSessionMode({ sessionId: this.sessionId, modeId: copilotMode });
    return true;
  }

  async setModel(model: string): Promise<boolean> {
    const conn = this.transport.getConnection();
    if (!this.sessionId || !conn) return false;
    try {
      await (
        conn as unknown as {
          unstable_setSessionModel: (params: {
            sessionId: string;
            modelId: string;
          }) => Promise<void>;
        }
      ).unstable_setSessionModel({ sessionId: this.sessionId, modelId: model });
      return true;
    } catch {
      return false;
    }
  }

  mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    return mapCopilotJsonToEvents(parsed as CopilotEvent);
  }

  private launch(prompt: string, opts: SpawnOpts, resumeSessionId: string | null): ManagedProcess {
    this.storedOpts = opts;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];
    this.dataCallbacks = dataCallbacks;
    this.exitCallbacks = exitCallbacks;

    // Set up the client handler
    this.activeToolCalls = new Set<string>();
    this.clientHandler = new CopilotClientHandler(
      (event) => this.emitNdjson(event),
      () => this.approvalHandler,
      this.activeToolCalls,
    );

    const isResume = resumeSessionId !== null;
    const copilotArgs = CopilotAdapter.buildArgs(opts, isResume, resumeSessionId);
    const cp = BaseAgentAdapter.spawnDetached('copilot', copilotArgs, opts);
    this.childProcess = cp;

    // Create ACP connection via transport
    this.createTransportConnection(cp);

    cp.stderr?.on('data', (chunk: Buffer) => {
      for (const cb of dataCallbacks) cb(chunk.toString('utf-8'));
    });

    let exitFired = false;
    cp.on('exit', (code) => {
      if (!exitFired) {
        exitFired = true;
        for (const cb of exitCallbacks) cb(code);
      }
    });

    // Async init chain — catch rejections to prevent unhandled promise crashes.
    this.currentTurn = this.initAndRun(prompt, opts, resumeSessionId).catch((err: Error) => {
      log.error({ err }, 'init failed');
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
      pid: cp.pid ?? null,
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
      const initResult = await this.transport.initialize();
      this.sessionId = await this.transport.loadOrCreateSession(
        initResult.agentCapabilities,
        { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] },
        resumeSessionId,
      );
      if (!resumeSessionId && this.sessionId) {
        this.sessionRefCallback?.(this.sessionId);
      }
    } catch (err) {
      const message = extractMessage(err);
      this.emitNdjson({ type: 'copilot:turn-error', message: `Init failed: ${message}` });
      throw err;
    }

    // Emit init event with model and sessionId
    if (this.sessionId && opts.model) {
      this.emitNdjson({ type: 'copilot:init', model: opts.model, sessionId: this.sessionId });
    }

    // 3. First prompt
    await this.sendPrompt(prompt);
  }

  private async sendPrompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error('No active session');
    this.thinkingCallback?.(true);

    const image = this.pendingImage ?? undefined;
    this.pendingImage = null;

    try {
      const promptResponse = await this.transport.sendPrompt(this.sessionId, text, image);
      // Emit synthetic result event so session-process emits agent:result
      this.emitNdjson({
        type: 'copilot:turn-complete',
        result: promptResponse,
      });
    } catch (err) {
      const message = extractMessage(err);
      // Don't emit error for process exit — onExit handles that
      if (!message.includes('Copilot process exited') && !message.includes('Connection closed')) {
        this.emitNdjson({ type: 'copilot:turn-error', message });
      }
      throw err;
    } finally {
      this.thinkingCallback?.(false);
    }
  }

  /**
   * Emit a synthetic NDJSON line to all dataCallbacks. session-process.ts
   * parses these through the standard NDJSON pipeline and delegates to
   * mapJsonToEvents (copilot-event-mapper.ts).
   */
  private emitNdjson(event: CopilotEvent): void {
    const line = JSON.stringify(event) + '\n';
    for (const cb of this.dataCallbacks) cb(line);
  }
}
