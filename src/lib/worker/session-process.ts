import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, and, inArray, isNull, or } from 'drizzle-orm';
import { config } from '@/lib/config';
import { publish, subscribe, channelName } from '@/lib/realtime/pg-notify';
import { serializeEvent } from '@/lib/realtime/events';
import type { AgendoEvent, AgendoEventPayload, AgendoControl, SessionStatus } from '@/lib/realtime/events';
import { FileLogWriter } from '@/lib/worker/log-writer';
import type { AgentAdapter, SpawnOpts, ManagedProcess, ImageContent, PermissionDecision } from '@/lib/worker/adapters/types';
import type { Session } from '@/lib/types';
import { Future } from '@/lib/utils/future';

const SIGKILL_DELAY_MS = 5_000;

/**
 * Derive a log file path for a session.
 * Format: {LOG_DIR}/sessions/{yyyy}/{mm}/{sessionId}.log
 */
function resolveSessionLogPath(sessionId: string): string {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, '0');
  return join(config.LOG_DIR, 'sessions', yyyy, mm, `${sessionId}.log`);
}

/**
 * SessionProcess manages the full lifecycle of a single long-running agent
 * process tied to a session row. It handles:
 *   - Atomic session claim to prevent pg-boss double-execution
 *   - Spawning or resuming the underlying agent process via an adapter
 *   - Parsing agent output (Claude stream-json NDJSON) into AgendoEvents
 *   - Publishing events to PG NOTIFY for SSE fan-out
 *   - Writing a structured session log file
 *   - Receiving control messages (send message, cancel, redirect, tool-approval) via PG NOTIFY
 *   - Idle timeout management and graceful shutdown
 *   - Heartbeat updates every 30s for stale-job detection
 *   - Per-tool approval gating with session allowlist persistence
 *   - Synthetic tool-end events on cancellation to prevent forever-spinners
 *   - kill(pid, 0) liveness checks to detect silent crashes
 */
export class SessionProcess {
  private managedProcess: ManagedProcess | null = null;
  private logWriter: FileLogWriter | null = null;
  private unsubscribeControl: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutKilled = false;
  private interruptInProgress = false;
  private interruptKilled = false;
  private eventSeq = 0;
  private status: SessionStatus = 'active';
  private sessionRef: string | null = null;
  private exitFuture = new Future<number | null>();
  private activeToolUseIds = new Set<string>();
  private pendingApprovals = new Map<string, (decision: 'allow' | 'deny' | 'allow-session') => void>();

  constructor(
    private session: Session,
    private adapter: AgentAdapter,
    private workerId: string,
  ) {}

  /**
   * Claim the session row atomically, set up log writer, subscribe to the
   * control channel, and spawn (or resume) the agent process.
   *
   * @param prompt - The initial prompt to pass to the agent
   * @param resumeRef - If provided, the adapter resumes an existing session
   * @param spawnCwd - Working directory for the spawned process
   * @param envOverrides - Additional env vars to merge into the child environment
   * @param mcpConfigPath - Optional path to a pre-generated MCP JSON config file.
   *   When provided, `--mcp-config <path>` is appended to the agent spawn args.
   */
  async start(prompt: string, resumeRef?: string, spawnCwd?: string, envOverrides?: Record<string, string>, mcpConfigPath?: string): Promise<void> {
    // Atomic claim: prevent double-execution on pg-boss retry.
    // Only claim if status is idle/active and no other worker owns it.
    const [claimed] = await db
      .update(sessions)
      .set({ status: 'active', workerId: this.workerId, startedAt: new Date() })
      .where(
        and(
          eq(sessions.id, this.session.id),
          inArray(sessions.status, ['idle', 'active', 'ended']),
          or(isNull(sessions.workerId), eq(sessions.workerId, this.workerId)),
        ),
      )
      .returning({ id: sessions.id, eventSeq: sessions.eventSeq });

    if (!claimed) {
      console.log(`[session-process] Session ${this.session.id} already claimed — skipping`);
      return;
    }

    // Continue seq from wherever the previous session run left off so that
    // event IDs remain monotonically increasing across resumes and the SSE
    // client never sees duplicate IDs.
    this.eventSeq = claimed.eventSeq;

    // Set up log writer. Pass null for executionId since sessions track their own
    // stats independently (no byte/line flush to the executions table).
    const logPath = resolveSessionLogPath(this.session.id);
    this.logWriter = new FileLogWriter(null, logPath);
    this.logWriter.open();

    // Persist the log file path so the frontend can fetch it later.
    await db
      .update(sessions)
      .set({ logFilePath: logPath })
      .where(eq(sessions.id, this.session.id));

    // Subscribe to control channel for inbound messages (send, cancel, redirect, tool-approval).
    this.unsubscribeControl = await subscribe(
      channelName('agendo_control', this.session.id),
      (payload) => void this.onControl(payload),
    );

    // Build child env: start from the worker's own env, then strip vars that
    // would prevent claude from starting (e.g. CLAUDECODE causes a nested-session
    // guard error; CLAUDE_CODE_ENTRYPOINT is also stripped for safety).
    const childEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== 'CLAUDECODE' && key !== 'CLAUDE_CODE_ENTRYPOINT') {
        childEnv[key] = value;
      }
    }
    // Apply project/task env overrides on top of the base env.
    if (envOverrides) {
      for (const [k, v] of Object.entries(envOverrides)) {
        childEnv[k] = v;
      }
    }

    // Session identity vars — available to hooks and sub-processes via env.
    // These are already baked into the MCP config file; setting them in the
    // child env as well lets hooks (pre/post tool) read them without parsing JSON.
    childEnv['AGENDO_SESSION_ID'] = this.session.id;
    childEnv['AGENDO_AGENT_ID'] = this.session.agentId;
    if (this.session.taskId) {
      childEnv['AGENDO_TASK_ID'] = this.session.taskId;
    }

    const spawnOpts: SpawnOpts = {
      cwd: spawnCwd ?? '/tmp',
      env: childEnv,
      executionId: this.session.id,
      timeoutSec: this.session.idleTimeoutSec,
      maxOutputBytes: 10 * 1024 * 1024,
      persistentSession: true, // keep process alive after result for multi-turn
      permissionMode: this.session.permissionMode ?? 'default',
      allowedTools: this.session.allowedTools ?? [],
      ...(mcpConfigPath ? { extraArgs: ['--mcp-config', mcpConfigPath] } : {}),
    };

    // Wire approval handler so adapter can request per-tool approval
    this.adapter.setApprovalHandler((id, name, input) =>
      this.handleApprovalRequest(id, name, input)
    );

    // Wire thinking callback for agent:activity events
    this.adapter.onThinkingChange((thinking) => {
      void this.emitEvent({ type: 'agent:activity', thinking });
    });

    if (resumeRef) {
      // Emit the user's prompt as a user:message event so it appears in the
      // session log and is replayed after a page refresh (cold-resume path).
      await this.emitEvent({ type: 'user:message', text: prompt });
      this.managedProcess = this.adapter.resume(resumeRef, prompt, spawnOpts);
    } else {
      this.managedProcess = this.adapter.spawn(prompt, spawnOpts);
    }

    // Persist PID for SIGTERM/SIGKILL from other paths (e.g. API cancel endpoint).
    await db
      .update(sessions)
      .set({ pid: this.managedProcess.pid })
      .where(eq(sessions.id, this.session.id));

    // Wire process output and exit handlers.
    this.managedProcess.onData((chunk) => void this.onData(chunk));
    this.managedProcess.onExit((code) => void this.onExit(code));

    this.startHeartbeat();
  }

  // ---------------------------------------------------------------------------
  // Private: process output handling
  // ---------------------------------------------------------------------------

  private async onData(chunk: string): Promise<void> {
    // Write raw chunk to the session log file under the 'stdout' stream prefix.
    this.logWriter?.write(chunk, 'stdout');

    // Parse each NDJSON line and map to a structured AgendoEvent.
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) continue;

      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const partials = this.mapClaudeJsonToEvents(parsed);

        for (const partial of partials) {
          const event = await this.emitEvent(partial);

          // Track in-flight tool calls to enable synthetic cleanup on cancel.
          if (event.type === 'agent:tool-start') {
            this.activeToolUseIds.add(event.toolUseId);
          }
          if (event.type === 'agent:tool-end') {
            this.activeToolUseIds.delete(event.toolUseId);
          }

          // Persist sessionRef once the agent announces its session ID.
          if (event.type === 'session:init') {
            this.sessionRef = event.sessionRef;
            await db
              .update(sessions)
              .set({ sessionRef: event.sessionRef })
              .where(eq(sessions.id, this.session.id));
          }

          // After the agent finishes a result, transition to awaiting_input.
          // Skip during an interrupt — handleInterrupt() manages the transition
          // based on whether the process survived (warm vs cold resume).
          if (event.type === 'agent:result' && !this.interruptInProgress) {
            await this.transitionTo('awaiting_input');
            this.resetIdleTimer();
          }
        }
      } catch {
        // Line was valid text but not parseable JSON or mapping returned null.
        await this.emitEvent({ type: 'system:info', message: trimmed });
      }
    }
  }

  /**
   * Map a parsed Claude stream-json object to zero or more AgendoEvent partials.
   *
   * Claude's --output-format stream-json emits NDJSON where tool_use and
   * tool_result blocks are nested inside message.content arrays, NOT as
   * top-level types. Each call may return multiple events (e.g. one assistant
   * message containing both a text block and a tool_use block).
   */
  private mapClaudeJsonToEvents(
    parsed: Record<string, unknown>,
  ): AgendoEventPayload[] {
    const type = parsed.type as string | undefined;

    // Claude CLI system/init — announces the session ID and available slash commands
    if (type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
      const slashCommands = Array.isArray(parsed.slash_commands)
        ? (parsed.slash_commands as string[])
        : [];
      const mcpServers = Array.isArray(parsed.mcp_servers)
        ? (parsed.mcp_servers as Array<{ name: string; status?: string; tools?: string[] }>)
        : [];
      return [{ type: 'session:init', sessionRef: parsed.session_id as string, slashCommands, mcpServers }];
    }

    // Assistant turn: content is an array of blocks (text, tool_use, thinking, etc.)
    if (type === 'assistant') {
      const message = parsed.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const events: AgendoEventPayload[] = [];
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') {
          events.push({ type: 'agent:text', text: block.text });
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          events.push({ type: 'agent:thinking', text: block.thinking });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'agent:tool-start',
            toolUseId: (block.id as string | undefined) ?? '',
            toolName: (block.name as string | undefined) ?? '',
            input: (block.input as Record<string, unknown> | undefined) ?? {},
          });
        }
      }
      return events;
    }

    // User turn: content is an array of blocks (tool_result, etc.)
    if (type === 'user') {
      const message = parsed.message as
        | { content?: Array<Record<string, unknown>> }
        | undefined;
      const events: AgendoEventPayload[] = [];
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_result') {
          events.push({
            type: 'agent:tool-end',
            toolUseId: (block.tool_use_id as string | undefined) ?? '',
            content: block.content ?? null,
          });
        }
      }
      return events;
    }

    // Agent thinking output (top-level, extended thinking mode)
    if (type === 'thinking') {
      return [{ type: 'agent:thinking', text: (parsed.thinking as string | undefined) ?? '' }];
    }

    // Final result with cost/duration stats
    if (type === 'result') {
      const costUsd = (parsed.total_cost_usd as number | null | undefined) ?? null;
      const turns = (parsed.num_turns as number | null | undefined) ?? null;
      const durationMs = (parsed.duration_ms as number | null | undefined) ?? null;

      // Persist cumulative cost/turn stats to the session row.
      void db
        .update(sessions)
        .set({
          ...(costUsd !== null && { totalCostUsd: String(costUsd) }),
          ...(turns !== null && { totalTurns: turns }),
        })
        .where(eq(sessions.id, this.session.id));

      return [{ type: 'agent:result', costUsd, turns, durationMs }];
    }

    return [];
  }

  // ---------------------------------------------------------------------------
  // Private: control channel handling
  // ---------------------------------------------------------------------------

  private async onControl(payload: string): Promise<void> {
    let control: AgendoControl;
    try {
      control = JSON.parse(payload) as AgendoControl;
    } catch {
      console.warn(`[session-process] Malformed control payload for session ${this.session.id}`);
      return;
    }

    if (control.type === 'cancel') {
      await this.handleCancel();
    } else if (control.type === 'interrupt') {
      await this.handleInterrupt();
    } else if (control.type === 'message') {
      await this.pushMessage(control.text, control.image);
    } else if (control.type === 'redirect') {
      await this.pushMessage(control.newPrompt);
    } else if (control.type === 'tool-approval') {
      const resolver = this.pendingApprovals.get(control.approvalId);
      if (resolver) {
        this.pendingApprovals.delete(control.approvalId);
        resolver(control.decision);
        if (control.decision === 'allow-session') {
          await this.persistAllowedTool(control.toolName);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public: send a message to the running agent
  // ---------------------------------------------------------------------------

  /**
   * Push a user message to the running agent process.
   * Only valid when the session is active or awaiting_input.
   */
  async pushMessage(text: string, image?: ImageContent): Promise<void> {
    if (!['active', 'awaiting_input'].includes(this.status)) {
      console.warn(
        `[session-process] pushMessage ignored — session ${this.session.id} is ${this.status}`,
      );
      return;
    }
    await this.adapter.sendMessage(text, image);
    await this.emitEvent({ type: 'user:message', text });
    await this.transitionTo('active');
    this.resetIdleTimer();
  }

  // ---------------------------------------------------------------------------
  // Private: cancellation
  // ---------------------------------------------------------------------------

  private async handleCancel(): Promise<void> {
    await this.emitEvent({ type: 'system:info', message: 'Cancellation requested' });
    // Emit synthetic tool-end for every in-flight tool call to prevent forever-spinners
    for (const toolUseId of this.activeToolUseIds) {
      await this.emitEvent({
        type: 'agent:tool-end',
        toolUseId,
        content: '[Interrupted by user]',
      });
    }
    this.activeToolUseIds.clear();
    await this.adapter.interrupt();
    // Allow graceful shutdown; escalate to SIGKILL after grace period.
    setTimeout(() => {
      this.managedProcess?.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Private: soft interrupt (Stop — process stays alive)
  // ---------------------------------------------------------------------------

  private async handleInterrupt(): Promise<void> {
    this.interruptInProgress = true;
    // Pre-set interruptKilled so that if the process dies during the interrupt,
    // onExit transitions to 'idle' (resumable) instead of 'ended'.
    this.interruptKilled = true;

    await this.emitEvent({ type: 'system:info', message: 'Stopping...' });
    for (const toolUseId of this.activeToolUseIds) {
      await this.emitEvent({ type: 'agent:tool-end', toolUseId, content: '[Interrupted]' });
    }
    this.activeToolUseIds.clear();

    // Ask the adapter to send an interrupt signal. For Claude this writes a
    // control_request{subtype:'interrupt'} to stdin and waits up to 3s for a
    // 'result' event. If Claude handles it gracefully the process stays alive;
    // if it dies or times out, adapter.isAlive() will be false afterwards.
    await this.adapter.interrupt();

    this.interruptInProgress = false;

    if (this.adapter.isAlive()) {
      // Claude stopped the current action but is still running — warm session,
      // user can send another message immediately without a cold resume.
      this.interruptKilled = false; // process survived, clear the pre-set flag
      await this.transitionTo('awaiting_input');
      this.resetIdleTimer();
    }
    // else: process died during interrupt — interruptKilled=true so onExit will
    // transition to 'idle' (not 'ended'), keeping the session cold-resumable.
  }

  /**
   * Externally interrupt the session (e.g. from the API cancel route).
   * Emits synthetic tool-end events for in-flight tools, sends SIGINT via the
   * adapter, then escalates to SIGKILL after grace period.
   */
  async interrupt(): Promise<void> {
    for (const toolUseId of this.activeToolUseIds) {
      await this.emitEvent({ type: 'agent:tool-end', toolUseId, content: '[Interrupted by user]' });
    }
    this.activeToolUseIds.clear();
    await this.adapter.interrupt();
    setTimeout(() => {
      this.managedProcess?.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // Private: state transitions
  // ---------------------------------------------------------------------------

  private async transitionTo(status: SessionStatus): Promise<void> {
    this.status = status;
    await db
      .update(sessions)
      .set({ status, lastActiveAt: new Date() })
      .where(eq(sessions.id, this.session.id));
    await this.emitEvent({ type: 'session:state', status });
  }

  // ---------------------------------------------------------------------------
  // Private: idle timeout
  // ---------------------------------------------------------------------------

  /**
   * Reset (or start) the idle timeout countdown.
   * If the agent hasn't received a message within idleTimeoutSec after
   * entering awaiting_input, the session is forcefully terminated.
   */
  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.idleTimer = setTimeout(async () => {
      if (this.status !== 'awaiting_input') return;
      await this.emitEvent({
        type: 'system:info',
        message: `Idle timeout after ${this.session.idleTimeoutSec}s. Suspending session.`,
      });
      this.idleTimeoutKilled = true;
      this.managedProcess?.kill('SIGTERM');
      setTimeout(() => {
        this.managedProcess?.kill('SIGKILL');
      }, SIGKILL_DELAY_MS);
    }, this.session.idleTimeoutSec * 1_000);
  }

  // ---------------------------------------------------------------------------
  // Private: process exit
  // ---------------------------------------------------------------------------

  private async onExit(exitCode: number | null): Promise<void> {
    this.stopHeartbeat();
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Unsubscribe from the control channel to release the pg pool connection.
    this.unsubscribeControl?.();

    // Determine final session status based on exit code.
    // SIGINT (130) = user-requested cancel -> ended.
    // Clean exit (0) = agent finished normally -> idle (resumable).
    // Anything else -> ended.
    if (this.status === 'active' || this.status === 'awaiting_input') {
      if (exitCode === 0 || this.idleTimeoutKilled || this.interruptKilled) {
        await this.transitionTo('idle');
      } else {
        await this.emitEvent({
          type: 'system:error',
          message:
            `Session ended unexpectedly (exit code ${exitCode ?? 'null'}). ` +
            `This may be caused by an unsupported slash command (/mcp, /permissions) or a Claude CLI crash.`,
        });
        await this.transitionTo('ended');
        // Kill the companion terminal tmux session — session is no longer resumable.
        spawnSync('tmux', ['kill-session', '-t', `shell-${this.session.id}`], { stdio: 'ignore' });
      }
    }

    await db
      .update(sessions)
      .set({ endedAt: new Date() })
      .where(eq(sessions.id, this.session.id));

    if (this.logWriter) {
      await this.logWriter.close();
      this.logWriter = null;
    }

    this.exitFuture.resolve(exitCode);
  }

  // ---------------------------------------------------------------------------
  // Private: event emission
  // ---------------------------------------------------------------------------

  /**
   * Assign a monotonic sequence number, persist it to the sessions row,
   * publish the event to PG NOTIFY, and write it to the session log file.
   *
   * Returns the fully constructed AgendoEvent for downstream use.
   */
  private async emitEvent(
    partial: AgendoEventPayload,
  ): Promise<AgendoEvent> {
    const seq = ++this.eventSeq;

    // Keep eventSeq in sync on the session row so SSE reconnects know
    // how many events have been emitted without reading the log file.
    await db
      .update(sessions)
      .set({ eventSeq: seq })
      .where(eq(sessions.id, this.session.id));

    const event = {
      id: seq,
      sessionId: this.session.id,
      ts: Date.now(),
      ...partial,
    } as AgendoEvent;

    // Publish to the per-session PG NOTIFY channel. The SSE route listens
    // here and forwards events to connected browser clients.
    await publish(channelName('agendo_events', this.session.id), event);

    // Write the structured event line to the session log file for replay.
    if (this.logWriter) {
      this.logWriter.write(serializeEvent(event), 'system');
    }

    return event;
  }

  // ---------------------------------------------------------------------------
  // Private: heartbeat
  // ---------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await db
          .update(sessions)
          .set({ heartbeatAt: new Date() })
          .where(eq(sessions.id, this.session.id));
        // Liveness check: kill(pid, 0) throws ESRCH if the process is already dead.
        // This catches silent crashes where the exit handler never fired.
        if (this.managedProcess?.pid) {
          try {
            process.kill(this.managedProcess.pid, 0);
          } catch {
            console.warn(
              `[session-process] Session ${this.session.id}: process ${this.managedProcess.pid} died silently, recovering`,
            );
            void this.onExit(-1);
          }
        }
      } catch (err) {
        console.error(
          `[session-process] Heartbeat failed for session ${this.session.id}:`,
          err,
        );
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: tool approval
  // ---------------------------------------------------------------------------

  /**
   * Check whether a tool name is already on the session's persistent allowlist.
   * Supports exact match and prefix-match patterns (e.g. "Bash(npm test)" pattern
   * matches the tool name "Bash").
   */
  private isToolAllowed(toolName: string): boolean {
    const allowed = this.session.allowedTools;
    if (!allowed?.length) return false;
    return allowed.some((pattern) => {
      // exact match or prefix match (e.g. "Bash(npm test)" matches "Bash")
      return toolName === pattern || toolName.startsWith(pattern.split('(')[0]);
    });
  }

  /**
   * Append a tool name to the session's allowedTools list and persist it to DB.
   * Called when the user approves a tool with 'allow-session'.
   */
  private async persistAllowedTool(toolName: string): Promise<void> {
    const allowed = this.session.allowedTools ?? [];
    if (!allowed.includes(toolName)) {
      const updated = [...allowed, toolName];
      this.session.allowedTools = updated;
      await db
        .update(sessions)
        .set({ allowedTools: updated })
        .where(eq(sessions.id, this.session.id));
    }
  }

  /**
   * Handle a per-tool approval request from the adapter.
   * If the tool is already on the session allowlist, returns 'allow' immediately.
   * Otherwise, emits an agent:tool-approval event to the frontend and blocks
   * until the user responds via the control channel.
   */
  private async handleApprovalRequest(
    approvalId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    // Non-interactive modes: auto-allow without prompting the user.
    // Claude already receives --permission-mode <mode> via its CLI flag, so
    // this guard is primarily for Codex and Gemini adapters which relay their
    // permission requests through this handler.
    if (this.session.permissionMode !== 'default') {
      return 'allow';
    }

    // Check per-session allowlist — no round-trip to the user needed.
    if (this.isToolAllowed(toolName)) {
      return 'allow';
    }

    // Emit approval request event to frontend and block until user responds.
    await this.emitEvent({
      type: 'agent:tool-approval',
      approvalId,
      toolName,
      toolInput,
      dangerLevel: 0,
    });

    return new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, resolve);
    });
  }

  // ---------------------------------------------------------------------------
  // Public: wait for process completion
  // ---------------------------------------------------------------------------

  /**
   * Returns a promise that resolves with the process exit code once the
   * session terminates. Useful for the worker to await job completion.
   */
  waitForExit(): Promise<number | null> {
    return this.exitFuture.promise;
  }
}
