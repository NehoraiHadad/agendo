import { createLogger } from '@/lib/logger';

const log = createLogger('opencode-adapter');
import { AsyncLock } from '@/lib/utils/async-lock';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import {
  mapOpenCodeJsonToEvents,
  type OpenCodeEvent,
} from '@/lib/worker/adapters/opencode-event-mapper';
import {
  extractMessage,
  OpenCodeClientHandler,
} from '@/lib/worker/adapters/opencode-client-handler';
import { AcpTransport } from '@/lib/worker/adapters/gemini-acp-transport';
import type {
  AgentAdapter,
  ImageContent,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';
import { BaseAgentAdapter } from '@/lib/worker/adapters/base-adapter';

/**
 * Build the OPENCODE_CONFIG_CONTENT env var value for permission and MCP configuration.
 *
 * OpenCode reads config from the OPENCODE_CONFIG_CONTENT environment variable before
 * any ACP handshake. This is the primary mechanism for:
 *  - Permission bypass (bypassPermissions / dontAsk / acceptEdits)
 *  - MCP server pre-configuration as defense-in-depth fallback
 *
 * Note: OpenCode has NO --yolo or --approval-mode CLI flag — config injection is required.
 */
function buildOpenCodeConfig(opts: SpawnOpts): Record<string, string> {
  const config: Record<string, unknown> = {};

  // Permission configuration
  if (opts.permissionMode === 'bypassPermissions' || opts.permissionMode === 'dontAsk') {
    config.permission = {
      bash: 'allow',
      edit: 'allow',
      write: 'allow',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      task: 'allow',
      todowrite: 'allow',
      todoread: 'allow',
    };
  } else if (opts.permissionMode === 'acceptEdits') {
    config.permission = {
      bash: 'ask',
      edit: 'allow',
      write: 'allow',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
    };
  }

  // MCP server pre-configuration as defense-in-depth fallback
  // (primary path is ACP session/new mcpServers, but this ensures MCP works
  //  even if the ACP sdk.mcp.add() translation fails)
  if (opts.mcpServers?.length) {
    config.mcp = {};
    for (const srv of opts.mcpServers) {
      (config.mcp as Record<string, unknown>)[srv.name] = {
        type: 'local',
        command: [srv.command, ...srv.args],
        environment: Object.fromEntries(srv.env.map(({ name, value }) => [name, value])),
      };
    }
  }

  if (Object.keys(config).length === 0) return {};
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

export class OpenCodeAdapter extends BaseAgentAdapter implements AgentAdapter {
  private childProcess: ReturnType<typeof BaseAgentAdapter.spawnDetached> | null = null;
  private transport = new AcpTransport();
  private clientHandler: OpenCodeClientHandler | null = null;
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
  /** Active tool call IDs from `tool_call` events (bypass mode).
   *  Used to pair `tool_call_update` with its start event and avoid
   *  emitting orphaned tool-end events in default mode (where tools are
   *  tracked via the permission handler instead). */
  private activeToolCalls = new Set<string>();

  /** Timeout for session/prompt ACP requests (10 minutes). */
  static readonly PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;

  /**
   * Build OpenCode CLI args from SpawnOpts.
   *
   * OpenCode key differences from Gemini/Copilot:
   *  - `acp` is a SUBCOMMAND (not a flag): `opencode acp`
   *  - `--cwd` must be passed explicitly (not just process cwd)
   *  - No permission flags — use OPENCODE_CONFIG_CONTENT env var instead
   *  - Model in provider/model format: `anthropic/claude-sonnet-4-5`
   *  - Resume via `-s <sessionId>` flag
   */
  private static buildArgs(opts: SpawnOpts, resumeSessionId: string | null): string[] {
    // 'acp' is a SUBCOMMAND, not a flag
    const args = ['acp'];

    // OpenCode requires --cwd as an explicit flag (not just process cwd)
    if (opts.cwd) {
      args.push('--cwd', opts.cwd);
    }

    // Model in provider/model format (e.g. "anthropic/claude-sonnet-4-5")
    if (opts.model) {
      if (!opts.model.includes('/')) {
        log.warn(
          { model: opts.model },
          'OpenCode model should be in provider/model format (e.g. "anthropic/claude-sonnet-4-5")',
        );
      }
      args.push('-m', opts.model);
    }

    // Session resume via -s flag
    if (opts.sessionId) {
      args.push('-s', opts.sessionId);
    } else if (resumeSessionId) {
      args.push('-s', resumeSessionId);
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
    // Inject permission + MCP config via OPENCODE_CONFIG_CONTENT env var
    const openCodeEnv = buildOpenCodeConfig(opts);
    const mergedOpts: SpawnOpts = {
      ...opts,
      env: { ...opts.env, ...openCodeEnv },
    };
    return this.launch(prompt, mergedOpts, null);
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.sessionId = sessionRef;
    // Inject permission + MCP config via OPENCODE_CONFIG_CONTENT env var
    const openCodeEnv = buildOpenCodeConfig(opts);
    const mergedOpts: SpawnOpts = {
      ...opts,
      env: { ...opts.env, ...openCodeEnv },
    };
    return this.launch(prompt, mergedOpts, sessionRef);
  }

  extractSessionId(_output: string): string | null {
    return this.sessionId;
  }

  async sendMessage(
    message: string,
    image?: ImageContent,
    _priority?: import('@/lib/realtime/events').MessagePriority,
  ): Promise<void> {
    if (!this.sessionId) throw new Error('No active OpenCode ACP session');
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
    // OpenCode ACP mode IDs are agent names: 'plan', 'build', 'general', 'explore'
    // bypassPermissions and acceptEdits are handled at spawn time via OPENCODE_CONFIG_CONTENT,
    // not via runtime mode switching.
    const modeMap: Record<string, string> = {
      default: 'general',
      plan: 'plan',
    };
    const opencodeMode = modeMap[mode];
    if (!opencodeMode) return false;
    await conn.setSessionMode({ sessionId: this.sessionId, modeId: opencodeMode });
    return true;
  }

  async setModel(model: string): Promise<boolean> {
    const conn = this.transport.getConnection();
    if (!this.sessionId || !conn) return false;
    try {
      // OpenCode implements the standard ACP setSessionModel (no unstable_ prefix needed)
      await (
        conn as unknown as {
          setSessionModel: (params: { sessionId: string; modelId: string }) => Promise<void>;
        }
      ).setSessionModel({ sessionId: this.sessionId, modelId: model });
      return true;
    } catch {
      return false;
    }
  }

  mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    return mapOpenCodeJsonToEvents(parsed as OpenCodeEvent);
  }

  private launch(prompt: string, opts: SpawnOpts, resumeSessionId: string | null): ManagedProcess {
    this.storedOpts = opts;
    const dataCallbacks: Array<(chunk: string) => void> = [];
    const exitCallbacks: Array<(code: number | null) => void> = [];
    this.dataCallbacks = dataCallbacks;
    this.exitCallbacks = exitCallbacks;

    // Set up the client handler
    this.activeToolCalls = new Set<string>();
    this.clientHandler = new OpenCodeClientHandler(
      (event) => this.emitNdjson(event),
      () => this.approvalHandler,
      this.activeToolCalls,
    );

    const openCodeArgs = OpenCodeAdapter.buildArgs(opts, resumeSessionId);
    const cp = BaseAgentAdapter.spawnDetached('opencode', openCodeArgs, opts);
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
      this.emitNdjson({ type: 'opencode:turn-error', message: `Init failed: ${message}` });
      throw err;
    }

    // Emit init event with model and sessionId
    if (this.sessionId && opts.model) {
      this.emitNdjson({ type: 'opencode:init', model: opts.model, sessionId: this.sessionId });
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
        type: 'opencode:turn-complete',
        result: promptResponse,
      });
    } catch (err) {
      const message = extractMessage(err);
      // Don't emit error for process exit — onExit handles that
      if (!message.includes('OpenCode process exited') && !message.includes('Connection closed')) {
        this.emitNdjson({ type: 'opencode:turn-error', message });
      }
      throw err;
    } finally {
      this.thinkingCallback?.(false);
    }
  }

  /**
   * Emit a synthetic NDJSON line to all dataCallbacks. session-process.ts
   * parses these through the standard NDJSON pipeline and delegates to
   * mapJsonToEvents (opencode-event-mapper.ts).
   */
  private emitNdjson(event: OpenCodeEvent): void {
    const line = JSON.stringify(event) + '\n';
    for (const cb of this.dataCallbacks) cb(line);
  }
}
