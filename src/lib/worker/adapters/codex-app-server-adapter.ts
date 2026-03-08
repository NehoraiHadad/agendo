import * as readline from 'node:readline';
import * as tmux from '@/lib/worker/tmux-manager';
import { createLogger } from '@/lib/logger';
import type {
  AgentAdapter,
  AcpMcpServer,
  ManagedProcess,
  SpawnOpts,
} from '@/lib/worker/adapters/types';
import {
  handleCodexCommandApproval,
  handleCodexFileChangeApproval,
  handleCodexUserInputRequest,
} from '@/lib/worker/adapters/codex-approval-handlers';
import type { AgendoEventPayload } from '@/lib/realtime/events';
import { BaseAgentAdapter } from '@/lib/worker/adapters/base-adapter';
import { NdjsonRpcTransport } from '@/lib/worker/adapters/ndjson-rpc-transport';
import {
  mapAppServerEventToPayloads,
  isAppServerSyntheticEvent,
  normalizeThreadItem,
} from '@/lib/worker/adapters/codex-app-server-event-mapper';
import { SIGKILL_DELAY_MS } from '@/lib/worker/constants';

const log = createLogger('codex-app-server');

// ---------------------------------------------------------------------------
// Permission mode → Codex app-server approval / sandbox settings
// ---------------------------------------------------------------------------

type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never';
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

function getApprovalPolicy(mode?: string): ApprovalPolicy {
  switch (mode) {
    case 'bypassPermissions':
    case 'dontAsk':
      return 'never';
    default:
      return 'on-request';
  }
}

function getSandboxMode(mode?: string): SandboxMode {
  switch (mode) {
    case 'bypassPermissions':
    case 'dontAsk':
      return 'danger-full-access';
    case 'plan':
      return 'read-only';
    default:
      return 'workspace-write';
  }
}

/**
 * Persistent adapter for the Codex `app-server` JSON-RPC protocol.
 *
 * Replaces the old spawn-per-turn `codex exec` approach. This adapter spawns
 * `codex app-server` ONCE and communicates via
 * NDJSON JSON-RPC 2.0 over stdio — the same protocol VS Code, JetBrains,
 * and Xcode use.
 *
 * Protocol framing: NDJSON (newline-delimited JSON), NOT Content-Length/LSP.
 *
 * Key protocol flow:
 *   initialize → thread/start → turn/start → [notifications] → turn/completed
 *   → turn/start (next message, SAME process)
 *
 * Approval handling:
 *   Server sends: { jsonrpc:"2.0", id: N, method: "item/commandExecution/requestApproval", params: {...} }
 *   Client replies: { jsonrpc:"2.0", id: N, result: { decision: "accept"|"decline"|... } }
 */
export class CodexAppServerAdapter extends BaseAgentAdapter implements AgentAdapter {
  private childProcess: ReturnType<typeof BaseAgentAdapter.spawnDetached> | null = null;
  private rl: readline.Interface | null = null;
  private tmuxSessionName = '';

  /** Codex thread ID (equivalent to sessionRef for resume). */
  private threadId: string | null = null;
  /** Current turn ID — needed for turn/interrupt. */
  private currentTurnId: string | null = null;
  /** Model reported by thread/start (for session:init event). */
  private threadModel = '';
  /** Current permission mode (updated by setPermissionMode). */
  private permissionMode: string | undefined;
  /** Current model (updated by setModel). */
  private model: string | undefined;
  /** MCP servers to inject via config/batchWrite during initialization. */
  private mcpServers: AcpMcpServer[] | undefined;
  /** System-level instructions injected via developerInstructions in thread/start. */
  private developerInstructions: string | undefined;
  /** Token usage from thread/tokenUsage/updated notification. */
  private tokenUsage: { used: number; limit: number } | null = null;
  /** Whether a context compaction is currently in progress. */
  private compacting = false;
  /** Whether the current turn is active (set on turn/started, cleared on turn/completed). */
  private turnActive = false;
  /** Interval handle for the MCP server health check (mcpServerStatus/list). */
  private mcpHealthCheckInterval: ReturnType<typeof setInterval> | null = null;

  /** NDJSON JSON-RPC transport layer (handles send/receive/dispatch). */
  private _transport: NdjsonRpcTransport | null = null;
  private alive = false;

  /** Access the transport with a runtime guard (avoids non-null assertions). */
  private get transport(): NdjsonRpcTransport {
    if (!this._transport) throw new Error('transport not initialized');
    return this._transport;
  }

  /** Stable callbacks that persist across calls (like virtual process pattern). */
  private dataCallbacks: Array<(chunk: string) => void> = [];
  private exitCallbacks: Array<(code: number | null) => void> = [];

  // -------------------------------------------------------------------------
  // AgentAdapter interface
  // -------------------------------------------------------------------------

  spawn(prompt: string, opts: SpawnOpts): ManagedProcess {
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    this.mcpServers = opts.mcpServers;
    this.developerInstructions = opts.developerInstructions;
    this.dataCallbacks = [];
    this.exitCallbacks = [];
    this.tmuxSessionName = `codex-as-${opts.executionId}`;
    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    this.launchServer(opts);
    this.initAndStartThread(prompt, opts, null);

    return this.buildVirtualProcess();
  }

  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    this.threadId = sessionRef;
    this.permissionMode = opts.permissionMode;
    this.model = opts.model;
    this.mcpServers = opts.mcpServers;
    this.developerInstructions = opts.developerInstructions;
    this.dataCallbacks = [];
    this.exitCallbacks = [];
    this.tmuxSessionName = `codex-as-${opts.executionId}`;
    tmux.createSession(this.tmuxSessionName, { cwd: opts.cwd });

    this.launchServer(opts);
    this.initAndStartThread(prompt, opts, sessionRef);

    return this.buildVirtualProcess();
  }

  extractSessionId(_output: string): string | null {
    return this.threadId;
  }

  async sendMessage(message: string): Promise<void> {
    if (!this.threadId) {
      throw new Error('No Codex thread ID — cannot send follow-up message');
    }
    await this.startTurn(message);
  }

  async interrupt(): Promise<void> {
    const threadId = this.threadId;
    const turnId = this.currentTurnId;
    if (!threadId || !turnId) return;

    try {
      await this.transport.call('turn/interrupt', { threadId, turnId }, 5000);
    } catch {
      // Interrupt timed out or failed — fall back to SIGTERM
      const cp = this.childProcess;
      if (cp?.pid) {
        await BaseAgentAdapter.killWithGrace(cp, SIGKILL_DELAY_MS);
      }
    }
  }

  isAlive(): boolean {
    return this.alive;
  }

  async setPermissionMode(mode: string): Promise<boolean> {
    this.permissionMode = mode;
    return true;
  }

  async setModel(model: string): Promise<boolean> {
    try {
      await this.transport.call('setDefaultModel', {
        model,
        reasoningEffort: null,
      });
      this.model = model;
      return true;
    } catch (err) {
      log.error({ err, model }, 'setDefaultModel RPC failed');
      return false;
    }
  }

  /**
   * Map a synthetic `as:*` JSON object to AgendoEventPayloads.
   * Called by session-process.ts for every JSON line emitted to dataCallbacks.
   */
  mapJsonToEvents(parsed: Record<string, unknown>): AgendoEventPayload[] {
    if (!isAppServerSyntheticEvent(parsed)) return [];
    return mapAppServerEventToPayloads(parsed);
  }

  // -------------------------------------------------------------------------
  // Private: server launch
  // -------------------------------------------------------------------------

  private launchServer(opts: SpawnOpts): void {
    this.childProcess = BaseAgentAdapter.spawnDetached('codex', ['app-server'], opts);
    this.alive = true;
    const cp = this.childProcess;

    if (!cp.stdout) {
      throw new Error('codex app-server stdout is not available');
    }

    this._transport = new NdjsonRpcTransport({
      getStdin: () => cp.stdin ?? null,
      onServerRequest: (id, method, params) => {
        this.handleServerRequest(id, method, params).catch((err: unknown) => {
          log.error({ err }, 'handleServerRequest error');
        });
      },
      onNotification: (method, params) => {
        this.handleNotification(method, params);
      },
    });

    this.rl = readline.createInterface({ input: cp.stdout });

    this.rl.on('line', (line) => {
      this.transport.processLine(line);
    });

    cp.stderr?.on('data', (chunk: Buffer) => {
      // Forward stderr as raw text (session-process treats non-JSON as system:info)
      for (const cb of this.dataCallbacks) cb(chunk.toString('utf-8'));
    });

    cp.on('exit', (code) => {
      this.alive = false;
      this.rl?.close();
      // Stop the MCP health check if running
      if (this.mcpHealthCheckInterval) {
        clearInterval(this.mcpHealthCheckInterval);
        this.mcpHealthCheckInterval = null;
      }
      // Reject all pending requests
      this._transport?.rejectAll('codex app-server exited');
      for (const cb of this.exitCallbacks) cb(code);
    });

    // Start polling MCP server health only when MCP servers are configured.
    // The health check begins immediately; the first poll fires after 60s.
    if (opts.mcpServers && opts.mcpServers.length > 0) {
      this.startMcpHealthCheck();
    }
  }

  // -------------------------------------------------------------------------
  // Private: async initialization chain (fire-and-forget from spawn/resume)
  // -------------------------------------------------------------------------

  private initAndStartThread(
    initialPrompt: string,
    opts: SpawnOpts,
    resumeThreadId: string | null,
  ): void {
    this.runInitChain(initialPrompt, opts, resumeThreadId).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'init chain failed');
      this.emitSynthetic({ type: 'as:error', message });
      // Trigger exit so session-process can clean up
      this.alive = false;
      for (const cb of this.exitCallbacks) cb(1);
    });
  }

  private async runInitChain(
    initialPrompt: string,
    opts: SpawnOpts,
    resumeThreadId: string | null,
  ): Promise<void> {
    // 1. Initialize
    await this.transport.call('initialize', {
      clientInfo: { name: 'agendo', title: 'Agendo', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    // Required by JSON-RPC handshake: client must send `initialized` notification
    this.transport.notify('initialized', {});

    // 2a. Inject MCP servers via config/batchWrite (when provided by session-runner).
    //     Must happen after initialized and before thread/start so Codex loads MCPs
    //     for the session. env is converted from ACP array format to a plain dict.
    if (this.mcpServers && this.mcpServers.length > 0) {
      const mcpValue: Record<
        string,
        { command: string; args: string[]; env: Record<string, string> }
      > = {};
      for (const srv of this.mcpServers) {
        mcpValue[srv.name] = {
          command: srv.command,
          args: srv.args,
          env: Object.fromEntries(srv.env.map((e) => [e.name, e.value])),
        };
      }
      await this.transport.call('config/batchWrite', {
        edits: [{ keyPath: 'mcp_servers', value: mcpValue, mergeStrategy: 'replace' }],
      });
      log.info({ count: this.mcpServers.length }, 'MCP config injected');
    }

    // 2. Start or resume thread
    if (resumeThreadId) {
      // Resume an existing thread
      const result = await this.transport.call('thread/resume', {
        threadId: resumeThreadId,
        cwd: opts.cwd,
        approvalPolicy: getApprovalPolicy(opts.permissionMode),
        sandbox: getSandboxMode(opts.permissionMode),
        model: opts.model ?? null,
        persistExtendedHistory: false,
        ...(this.developerInstructions
          ? { developerInstructions: this.developerInstructions }
          : {}),
      });
      const thread = (result.thread as Record<string, unknown>) ?? result;
      this.threadId = resumeThreadId;
      this.threadModel = (result.model as string) ?? '';
      this.sessionRefCallback?.(resumeThreadId);
      // Emit init event so session:init is recorded with the model
      this.emitSynthetic({
        type: 'as:thread.started',
        threadId: resumeThreadId,
        model: this.threadModel,
      });
      void thread; // suppress unused warning
    } else {
      // Start a new thread
      const result = await this.transport.call('thread/start', {
        model: opts.model ?? null,
        cwd: opts.cwd,
        approvalPolicy: getApprovalPolicy(opts.permissionMode),
        sandbox: getSandboxMode(opts.permissionMode),
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ...(this.developerInstructions
          ? { developerInstructions: this.developerInstructions }
          : {}),
      });
      const thread = result.thread as Record<string, unknown>;
      this.threadId = thread.id as string;
      this.threadModel = (result.model as string) ?? '';
      this.sessionRefCallback?.(this.threadId);
      // The thread/started notification will be emitted from the transport below,
      // but the model isn't in the notification params, so we also emit it here.
      // session-process ignores duplicate session:init so this is safe.
      this.emitSynthetic({
        type: 'as:thread.started',
        threadId: this.threadId,
        model: this.threadModel,
      });
    }

    // 3. Start first turn with initial prompt
    await this.startTurn(initialPrompt);
  }

  // -------------------------------------------------------------------------
  // Private: turn management
  // -------------------------------------------------------------------------

  private async startTurn(prompt: string): Promise<void> {
    if (!this.threadId) throw new Error('No thread ID for turn/start');

    const approvalPolicy = getApprovalPolicy(this.permissionMode);
    const sandboxMode = getSandboxMode(this.permissionMode);

    // Build sandboxPolicy from sandboxMode string
    const sandboxPolicy =
      sandboxMode === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : sandboxMode === 'read-only'
          ? { type: 'readOnly' }
          : {
              type: 'workspaceWrite',
              writableRoots: [],
              readOnlyAccess: { type: 'fullAccess' },
              network_access: false,
              exclude_tmpdir_env_var: false,
              exclude_slash_tmp: false,
            };

    await this.transport.call('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      approvalPolicy,
      sandboxPolicy,
      model: this.model ?? null,
      effort: null,
      summary: 'auto',
      outputSchema: null,
    });
  }

  // -------------------------------------------------------------------------
  // Private: notification handler
  // -------------------------------------------------------------------------

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      // Thread created (from thread/start or thread/resume response notification)
      case 'thread/started':
        // thread/started notification doesn't carry model — we emit as:thread.started
        // from the response handler in runInitChain() instead.
        break;

      case 'turn/started': {
        const turn = (params.turn as Record<string, unknown>) ?? {};
        this.currentTurnId = turn.id as string;
        this.turnActive = true;
        this.thinkingCallback?.(true);
        this.emitSynthetic({ type: 'as:turn.started' });
        break;
      }

      case 'turn/completed': {
        this.currentTurnId = null;
        this.turnActive = false;
        this.thinkingCallback?.(false);
        const turn = params.turn as Record<string, unknown>;
        const status = (turn?.status as string) ?? 'completed';
        const error = turn?.error as { message: string; additionalDetails?: string | null } | null;
        this.emitSynthetic({ type: 'as:turn.completed', status, error: error ?? null });
        break;
      }

      case 'item/started': {
        const item = params.item as Record<string, unknown>;
        const normalized = normalizeThreadItem(item, () => {
          this.compacting = false;
          this.emitSynthetic({ type: 'as:info', message: 'Context compacted.' });
        });
        if (normalized) this.emitSynthetic({ type: 'as:item.started', item: normalized });
        break;
      }

      case 'item/completed': {
        const item = params.item as Record<string, unknown>;
        const normalized = normalizeThreadItem(item, () => {
          this.compacting = false;
          this.emitSynthetic({ type: 'as:info', message: 'Context compacted.' });
        });
        if (normalized) this.emitSynthetic({ type: 'as:item.completed', item: normalized });
        break;
      }

      case 'item/agentMessage/delta': {
        const delta = params.delta as string;
        const itemId = params.itemId as string;
        if (delta) this.emitSynthetic({ type: 'as:delta', text: delta, itemId });
        break;
      }

      case 'item/reasoning/summaryTextDelta': {
        const delta = params.delta as string;
        const itemId = params.itemId as string;
        if (delta) this.emitSynthetic({ type: 'as:reasoning.delta', text: delta, itemId });
        break;
      }

      case 'item/commandExecution/outputDelta': {
        const delta = params.delta as string;
        if (delta) this.emitSynthetic({ type: 'as:cmd-delta', text: delta });
        break;
      }

      case 'item/plan/delta': {
        const delta = params.delta as string;
        if (delta) this.emitSynthetic({ type: 'as:plan-delta', text: delta });
        break;
      }

      case 'turn/planUpdated': {
        // params.steps is an array of plan step objects emitted when Codex
        // updates the structured step list during a plan-mode turn.
        const steps = params.steps as Array<{ text?: string; status?: string }> | null;
        if (steps && steps.length > 0) {
          const text = steps.map((s) => `[${s.status ?? 'pending'}] ${s.text ?? ''}`).join('\n');
          this.emitSynthetic({ type: 'as:info', message: `Plan updated:\n${text}` });
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        const usage = params.usage as {
          inputTokenCount?: number;
          outputTokenCount?: number;
          cacheReadTokenCount?: number;
          cacheWriteTokenCount?: number;
        } | null;
        if (usage) {
          const used =
            (usage.inputTokenCount ?? 0) +
            (usage.outputTokenCount ?? 0) +
            (usage.cacheReadTokenCount ?? 0) +
            (usage.cacheWriteTokenCount ?? 0);
          // o4-mini context window is 200k tokens; use 200000 as the limit
          // if Codex doesn't report an explicit limit.
          const limit = 200000;
          this.tokenUsage = { used, limit };
          if (used / limit >= 0.8) {
            this.triggerCompaction().catch((err: unknown) => {
              log.error({ err }, 'compaction error');
            });
          }
        }
        break;
      }

      case 'error': {
        const errParams = params as { message?: string; error?: { message?: string } };
        const message =
          errParams.message ??
          (errParams.error as { message?: string })?.message ??
          'Unknown error';
        this.emitSynthetic({ type: 'as:error', message });
        break;
      }

      case 'sessionConfigured': {
        const configModel = params.model as string | undefined;
        if (configModel) {
          log.info({ model: configModel }, 'Codex confirmed model change');
          this.model = configModel;
          this.emitSynthetic({ type: 'as:info', message: `Model set to ${configModel}` });
        }
        break;
      }

      case 'model/rerouted': {
        const from = params.requestedModel as string | undefined;
        const to = params.actualModel as string | undefined;
        if (from && to) {
          log.info({ from, to }, 'Codex rerouted model');
          this.model = to;
          this.emitSynthetic({
            type: 'as:info',
            message: `Model rerouted: ${from} → ${to}`,
          });
        }
        break;
      }

      // Ignore: codex/event/* are duplicate wrapped versions of bare notifications
      // Ignore: account/rateLimits/updated, etc.
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Private: server request handler (approvals)
  // -------------------------------------------------------------------------

  private async handleServerRequest(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === 'item/commandExecution/requestApproval') {
      const result = await handleCodexCommandApproval(params, this.approvalHandler);
      this.transport.respond(id, result);
      return;
    }

    if (method === 'item/fileChange/requestApproval') {
      const decision = await handleCodexFileChangeApproval(params, this.approvalHandler);
      this.transport.respond(id, { decision });
      return;
    }

    if (method === 'tool/requestUserInput') {
      const answers = await handleCodexUserInputRequest(params, this.approvalHandler);
      this.transport.respond(id, { answers });
      return;
    }

    // Unknown server request — auto-decline
    log.warn({ method }, 'Unknown server request method');
    this.transport.respond(id, { decision: 'decline' });
  }

  // -------------------------------------------------------------------------
  // Public: steer + rollback (Codex-specific controls)
  // -------------------------------------------------------------------------

  async steer(message: string): Promise<void> {
    const threadId = this.threadId;
    const turnId = this.currentTurnId;
    if (!threadId || !turnId || !this.turnActive) return;
    await this.transport.call('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: message, text_elements: [] }],
    });
  }

  async rollback(numTurns = 1): Promise<void> {
    const threadId = this.threadId;
    if (!threadId) return;
    await this.transport.call('thread/rollback', { threadId, numTurns }, 15000);
    this.emitSynthetic({
      type: 'as:info',
      message: `Rolled back ${numTurns} turn(s). File changes were NOT reverted.`,
    });
  }

  // -------------------------------------------------------------------------
  // Private: MCP server health check (60s interval)
  // -------------------------------------------------------------------------

  /**
   * Polls `mcpServerStatus/list` every 60 seconds and emits a system warning
   * if any configured MCP server has no tools registered (a proxy for a failed
   * or disconnected server, since a healthy server always exposes at least one
   * tool).
   *
   * Note: `mcpServerStatus/list` is a v2 API confirmed present in the installed
   * Codex binary (verified via `codex app-server generate-ts`). The response
   * shape is `{ data: Array<{ name, tools, resources, resourceTemplates, authStatus }> }`.
   * There is no explicit connection-state field, so we infer disconnection from
   * an empty tools map combined with a `notLoggedIn` auth status.
   */
  private startMcpHealthCheck(): void {
    const MCP_HEALTH_INTERVAL_MS = 60_000;

    this.mcpHealthCheckInterval = setInterval(() => {
      if (!this.alive) {
        if (this.mcpHealthCheckInterval) {
          clearInterval(this.mcpHealthCheckInterval);
          this.mcpHealthCheckInterval = null;
        }
        return;
      }

      this.transport
        .call('mcpServerStatus/list', {}, 10_000)
        .then((result) => {
          type McpEntry = { name: string; tools: Record<string, unknown>; authStatus: string };
          const servers = (result.data as McpEntry[] | undefined) ?? [];
          const disconnected = servers.filter(
            (s) => Object.keys(s.tools ?? {}).length === 0 && s.authStatus === 'notLoggedIn',
          );
          if (disconnected.length > 0) {
            const names = disconnected.map((s) => s.name).join(', ');
            this.emitSynthetic({
              type: 'as:info',
              message: `Warning: MCP server(s) appear disconnected or have no tools: ${names}`,
            });
          }
        })
        .catch((err: unknown) => {
          // Non-fatal: health check failure just gets logged, not propagated
          log.warn({ err }, 'MCP health check failed');
        });
    }, MCP_HEALTH_INTERVAL_MS);
  }

  // -------------------------------------------------------------------------
  // Private: context compaction
  // -------------------------------------------------------------------------

  private async triggerCompaction(): Promise<void> {
    if (this.compacting || !this.threadId) return;
    this.compacting = true;
    this.emitSynthetic({ type: 'as:compact-start' });
    await this.transport.call('thread/compact/start', { threadId: this.threadId }, 30000);
  }

  // -------------------------------------------------------------------------
  // Private: synthetic event emission
  // -------------------------------------------------------------------------

  private emitSynthetic(event: Record<string, unknown>): void {
    const line = JSON.stringify(event) + '\n';
    for (const cb of this.dataCallbacks) cb(line);
  }

  // -------------------------------------------------------------------------
  // Private: virtual ManagedProcess
  // -------------------------------------------------------------------------

  private buildVirtualProcess(): ManagedProcess {
    return {
      pid: this.childProcess?.pid ?? 0,
      tmuxSession: this.tmuxSessionName,
      stdin: null, // We use JSON-RPC, not raw stdin
      kill: BaseAgentAdapter.buildKill(() => this.childProcess),
      onData: (cb) => this.dataCallbacks.push(cb),
      onExit: (cb) => this.exitCallbacks.push(cb),
    };
  }
}
