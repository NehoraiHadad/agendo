import { createLogger } from '@/lib/logger';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';
import { homedir } from 'node:os';

const log = createLogger('gemini-adapter');
import { AsyncLock } from '@/lib/utils/async-lock';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { mapGeminiJsonToEvents, type GeminiEvent } from '@/lib/worker/adapters/gemini-event-mapper';
import { extractMessage, GeminiClientHandler } from '@/lib/worker/adapters/gemini-client-handler';
import { AcpTransport } from '@/lib/worker/adapters/gemini-acp-transport';
import type {
  AgentAdapter,
  ImageContent,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';
import { BaseAgentAdapter } from '@/lib/worker/adapters/base-adapter';

/** Slash command entry returned from TOML scanning. */
interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

/**
 * Extract a simple string field value from a TOML file using regex.
 * Only handles `key = "value"` and `key = 'value'` patterns (single-line).
 */
function extractTomlString(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*["']([^"'\\r\\n]*)["']`, 'm'));
  return match?.[1] ?? '';
}

/**
 * Recursively list all `.toml` files under `dir`, returning their paths.
 * Errors (missing dir, permissions, etc.) are silently ignored.
 */
function listTomlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listTomlFiles(fullPath));
      } else if (entry.isFile() && extname(entry.name) === '.toml') {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or is not readable — skip silently
  }
  return results;
}

/**
 * Scan `~/.gemini/commands/` and `<cwd>/.gemini/commands/` for custom TOML commands.
 * Subdirectories create namespaced commands: `git/commit.toml` → `/git:commit`.
 * Returns an array of slash command descriptors, deduplicated by name (cwd takes priority).
 */
function loadGeminiCustomCommands(cwd: string): SlashCommand[] {
  const globalDir = join(homedir(), '.gemini', 'commands');
  const localDir = join(cwd, '.gemini', 'commands');

  const commandsMap = new Map<string, SlashCommand>();

  for (const dir of [globalDir, localDir]) {
    const tomlFiles = listTomlFiles(dir);
    for (const filePath of tomlFiles) {
      try {
        const relPath = relative(dir, filePath);
        const parts = relPath.split('/');
        const stemName = basename(parts[parts.length - 1], '.toml');
        const namespace = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
        const commandName = namespace ? `/${namespace}:${stemName}` : `/${stemName}`;

        const content = readFileSync(filePath, 'utf-8');
        const description = extractTomlString(content, 'description');
        const prompt = extractTomlString(content, 'prompt');
        const argumentHint = prompt ? '<text>' : '';

        commandsMap.set(commandName, { name: commandName, description, argumentHint });
      } catch {
        // Malformed or unreadable file — skip silently
      }
    }
  }

  return Array.from(commandsMap.values());
}

export class GeminiAdapter extends BaseAgentAdapter implements AgentAdapter {
  private childProcess: ReturnType<typeof BaseAgentAdapter.spawnDetached> | null = null;
  private transport = new AcpTransport();
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
  /** Cached custom TOML commands for ACP-command merging. */
  private customTomlCommands: SlashCommand[] = [];

  /** Timeout for session/prompt ACP requests (10 minutes). */
  static readonly PROMPT_TIMEOUT_MS = 10 * 60 * 1_000;

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
    if (opts.policyFiles?.length) {
      args.push('--policy', ...opts.policyFiles);
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

  async sendMessage(message: string, image?: ImageContent): Promise<void> {
    if (!this.sessionId) throw new Error('No active Gemini ACP session');
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
    // "plan" is NOT a valid ACP mode (rejected with -32603).
    const modeMap: Record<string, string> = {
      default: 'default',
      acceptEdits: 'autoEdit',
      bypassPermissions: 'yolo',
      dontAsk: 'yolo',
    };
    const geminiMode = modeMap[mode];
    if (!geminiMode) return false;
    await conn.setSessionMode({ sessionId: this.sessionId, modeId: geminiMode });
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
    this.createTransportConnection(cp);

    // Re-initialize ACP and reload session
    try {
      const initResult = await this.transport.initialize();
      this.sessionId = await this.transport.loadOrCreateSession(
        initResult.agentCapabilities,
        { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] },
        this.sessionId,
      );
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

    // Create ACP connection via transport
    this.createTransportConnection(cp);

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
      this.emitNdjson({ type: 'gemini:turn-error', message: `Init failed: ${message}` });
      throw err;
    }

    // Emit init event with model and sessionId
    if (this.sessionId && opts.model) {
      this.emitNdjson({ type: 'gemini:init', model: opts.model, sessionId: this.sessionId });
    }

    // Load custom TOML commands and emit them (merged with any future ACP commands)
    this.customTomlCommands = loadGeminiCustomCommands(opts.cwd);
    if (this.customTomlCommands.length > 0) {
      // Emit TOML-only commands immediately; ACP update (if it arrives) will also be merged
      this.emitNdjson({ type: 'gemini:commands', commands: this.customTomlCommands });
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
        type: 'gemini:turn-complete',
        result: promptResponse,
      });
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
   *
   * For `gemini:commands` events, merges ACP commands with locally-scanned
   * custom TOML commands. ACP commands take priority on name collision.
   */
  private emitNdjson(event: GeminiEvent): void {
    let finalEvent = event;
    if (event.type === 'gemini:commands' && this.customTomlCommands.length > 0) {
      // Merge: start with TOML commands, overwrite with ACP commands (ACP takes priority)
      const merged = new Map<string, SlashCommand>();
      for (const cmd of this.customTomlCommands) {
        merged.set(cmd.name, cmd);
      }
      for (const cmd of event.commands) {
        merged.set(cmd.name, cmd);
      }
      finalEvent = { type: 'gemini:commands', commands: Array.from(merged.values()) };
    }
    const line = JSON.stringify(finalEvent) + '\n';
    for (const cb of this.dataCallbacks) cb(line);
  }
}
