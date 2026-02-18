import { join } from 'node:path';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, and, inArray, isNull, or } from 'drizzle-orm';
import { config } from '@/lib/config';
import { publish, subscribe, channelName } from '@/lib/realtime/pg-notify';
import { serializeEvent } from '@/lib/realtime/events';
import type { AgendoEvent, AgendoEventPayload, AgendoControl, SessionStatus } from '@/lib/realtime/events';
import { FileLogWriter } from '@/lib/worker/log-writer';
import type { AgentAdapter, SpawnOpts, ManagedProcess, ImageContent } from '@/lib/worker/adapters/types';
import type { Session } from '@/lib/types';

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
 *   - Receiving control messages (send message, cancel, redirect) via PG NOTIFY
 *   - Idle timeout management and graceful shutdown
 *   - Heartbeat updates every 30s for stale-job detection
 */
export class SessionProcess {
  private managedProcess: ManagedProcess | null = null;
  private logWriter: FileLogWriter | null = null;
  private unsubscribeControl: (() => void) | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutKilled = false;
  private eventSeq = 0;
  private status: SessionStatus = 'active';
  private sessionRef: string | null = null;
  private exitResolve: ((code: number | null) => void) | null = null;

  constructor(
    private session: Session,
    private adapter: AgentAdapter,
    private executionId: string,
    private workerId: string,
  ) {}

  /**
   * Claim the session row atomically, set up log writer, subscribe to the
   * control channel, and spawn (or resume) the agent process.
   *
   * @param prompt - The initial prompt to pass to the agent
   * @param resumeRef - If provided, the adapter resumes an existing session
   * @param spawnCwd - Working directory for the spawned process
   */
  async start(prompt: string, resumeRef?: string, spawnCwd?: string): Promise<void> {
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
      .returning({ id: sessions.id });

    if (!claimed) {
      console.log(`[session-process] Session ${this.session.id} already claimed — skipping`);
      return;
    }

    // Set up log writer. FileLogWriter flushes byte/line stats to the executions
    // table; passing executionId keeps those stats current for the owning execution.
    const logPath = resolveSessionLogPath(this.session.id);
    this.logWriter = new FileLogWriter(this.executionId, logPath);
    this.logWriter.open();

    // Persist the log file path so the frontend can fetch it later.
    await db
      .update(sessions)
      .set({ logFilePath: logPath })
      .where(eq(sessions.id, this.session.id));

    // Subscribe to control channel for inbound messages (send, cancel, redirect).
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

    const spawnOpts: SpawnOpts = {
      cwd: spawnCwd ?? '/tmp',
      env: childEnv,
      executionId: this.executionId,
      timeoutSec: this.session.idleTimeoutSec,
      maxOutputBytes: 10 * 1024 * 1024,
      persistentSession: true, // keep process alive after result for multi-turn
    };

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

          // Persist sessionRef once the agent announces its session ID.
          if (event.type === 'session:init') {
            this.sessionRef = event.sessionRef;
            await db
              .update(sessions)
              .set({ sessionRef: event.sessionRef })
              .where(eq(sessions.id, this.session.id));
          }

          // After the agent finishes a result, transition to awaiting_input.
          if (event.type === 'agent:result') {
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

    // Claude CLI system/init — announces the session ID
    if (type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
      return [{ type: 'session:init', sessionRef: parsed.session_id as string }];
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
    } else if (control.type === 'message') {
      await this.pushMessage(control.text, control.image);
    } else if (control.type === 'redirect') {
      await this.pushMessage(control.newPrompt);
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
    this.adapter.interrupt();
    // Allow graceful shutdown; escalate to SIGKILL after grace period.
    setTimeout(() => {
      this.managedProcess?.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
  }

  /**
   * Externally interrupt the session (e.g. from the API cancel route).
   * Sends SIGINT via the adapter, then escalates to SIGKILL after grace period.
   */
  interrupt(): void {
    this.adapter.interrupt();
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
      if (exitCode === 0 || this.idleTimeoutKilled) {
        await this.transitionTo('idle');
      } else {
        await this.transitionTo('ended');
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

    this.exitResolve?.(exitCode);
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
  // Public: wait for process completion
  // ---------------------------------------------------------------------------

  /**
   * Returns a promise that resolves with the process exit code once the
   * session terminates. Useful for the worker to await job completion.
   */
  waitForExit(): Promise<number | null> {
    return new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }
}
