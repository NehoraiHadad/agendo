import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-process');
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { config } from '@/lib/config';
import { publish, subscribe, channelName } from '@/lib/realtime/pg-notify';
import { serializeEvent } from '@/lib/realtime/events';
import type {
  AgendoEvent,
  AgendoEventPayload,
  AgendoControl,
  SessionStatus,
} from '@/lib/realtime/events';
import { FileLogWriter } from '@/lib/worker/log-writer';
import { sendPushToAll } from '@/lib/services/notification-service';
import { SessionTeamManager } from '@/lib/worker/session-team-manager';
import { capturePlanFilePath } from '@/lib/worker/session-plan-utils';
import {
  handleCancel,
  handleInterrupt,
  handleSetPermissionMode,
  handleSetModel,
  handleMessage,
  handleToolApproval,
  handleRedirect,
  handleToolResult,
  handleAnswerQuestion,
  handleSteer,
  handleRollback,
  handleReEnqueue,
  type SessionControlCtx,
} from '@/lib/worker/session-control-handlers';
import { SIGKILL_DELAY_MS } from '@/lib/worker/constants';
import { buildChildEnv } from '@/lib/worker/session-env';
import { buildSpawnOpts } from '@/lib/worker/spawn-opts-builder';
import { claimSession } from '@/lib/worker/session-claim';
import type {
  AgentAdapter,
  ManagedProcess,
  ImageContent,
  SessionStartOptions,
} from '@/lib/worker/adapters/types';
import type { Session } from '@/lib/types';
import { Future } from '@/lib/utils/future';
import { resetRecoveryCount } from '@/worker/zombie-reconciler';
import { ApprovalHandler } from '@/lib/worker/approval-handler';
import { ActivityTracker } from '@/lib/worker/activity-tracker';
import { mapClaudeJsonToEvents } from '@/lib/worker/adapters/claude-event-mapper';
import type { InFlightTool } from '@/lib/worker/interruption-marker';
import {
  ExitContext,
  cleanupResources,
  determineExitStatus,
} from '@/lib/worker/session-exit-logic';
import { SessionDataPipeline } from '@/lib/worker/session-data-pipeline';

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
  private exitCtx = new ExitContext();
  /** Stored cwd for plan file reading during clearContextRestart. */
  private spawnCwd: string | null = null;
  /** SIGKILL escalation timers — tracked so they can be cleared if the process exits early. */
  private sigkillTimers: ReturnType<typeof setTimeout>[] = [];
  private eventSeq = 0;
  private status: SessionStatus = 'active';
  private sessionRef: string | null = null;
  /** Handles NDJSON line buffering, parsing, event mapping, suppression, and enrichment. */
  private dataPipeline!: SessionDataPipeline;
  private exitFuture = new Future<number | null>();
  /** Resolves when the pg-boss slot should be freed: either on first awaiting_input
   *  transition or on process exit — whichever comes first. */
  private slotReleaseFuture = new Future<void>();
  private sessionStartTime = Date.now();
  private activeToolUseIds = new Set<string>();
  /** Maps toolUseId → {toolName, input} for tools currently in-flight, used to build interruption notes. */
  private activeToolInfo = new Map<string, InFlightTool>();
  /** Manages per-tool approval gates, interactive tool responses, and suppressed tool tracking. */
  private approvalHandler!: ApprovalHandler;
  /** Manages idle timer, heartbeat, MCP health check, and delta buffers. */
  private activityTracker!: ActivityTracker;
  /** Manages team inbox monitoring and TeamCreate/Delete lifecycle. */
  private teamManager!: SessionTeamManager;
  /** Temp TOML policy file path written for Gemini sessions; cleaned up on exit. */
  private policyFilePath: string | null = null;

  constructor(
    private session: Session,
    private adapter: AgentAdapter,
    private workerId: string,
  ) {
    this.approvalHandler = new ApprovalHandler(
      session,
      adapter,
      (payload) => this.emitEvent(payload),
      (status) => this.transitionTo(status),
      () => this.activityTracker.recordActivity(),
      () => capturePlanFilePath(session.id),
      this.activeToolUseIds,
    );

    this.teamManager = new SessionTeamManager({
      sessionId: session.id,
      emitEvent: async (p) => {
        await this.emitEvent(p);
      },
      recordActivity: () => this.activityTracker.recordActivity(),
      pushMessage: (text) => this.pushMessage(text),
      getStatus: () => this.status,
    });

    this.activityTracker = new ActivityTracker(
      session.id,
      // getIdleTimeoutSec: team sessions get 1 hour; regular sessions use idleTimeoutSec
      () => (this.teamManager.isActive ? 3600 : this.session.idleTimeoutSec),
      // getIdleTimeoutMessage: team-aware message
      (timeoutSec) =>
        this.teamManager.isActive
          ? `Team idle timeout after ${timeoutSec}s with no teammate activity. Suspending session.`
          : `Idle timeout after ${this.session.idleTimeoutSec}s. Suspending session.`,
      () => this.status,
      (payload) => this.emitEvent(payload),
      // onIdleKill: SIGTERM + schedule SIGKILL escalation
      () => {
        this.managedProcess?.kill('SIGTERM');
        const t = setTimeout(() => {
          this.managedProcess?.kill('SIGKILL');
        }, SIGKILL_DELAY_MS);
        this.sigkillTimers.push(t);
      },
      () => this.managedProcess?.pid,
      // onSilentCrash: treat as process exit with code -1
      () => {
        void this.onExit(-1);
      },
      this.adapter.getMcpStatus?.bind(this.adapter),
      // publishTextDelta: emit agent:text-delta directly to PG NOTIFY (no log write)
      async (text) => {
        const event: AgendoEvent = {
          id: ++this.eventSeq,
          sessionId: this.session.id,
          ts: Date.now(),
          type: 'agent:text-delta',
          text,
        };
        await publish(channelName('agendo_events', this.session.id), event);
      },
      // publishThinkingDelta: emit agent:thinking-delta directly to PG NOTIFY
      async (text) => {
        const event: AgendoEvent = {
          id: ++this.eventSeq,
          sessionId: this.session.id,
          ts: Date.now(),
          type: 'agent:thinking-delta',
          text,
        };
        await publish(channelName('agendo_events', this.session.id), event);
      },
    );
  }

  /**
   * Claim the session row atomically, set up log writer, subscribe to the
   * control channel, and spawn (or resume) the agent process.
   */
  async start(opts: SessionStartOptions): Promise<void> {
    const {
      prompt,
      resumeRef,
      spawnCwd: spawnCwdOpt,
      envOverrides,
      mcpConfigPath,
      mcpServers,
      initialImage,
      displayText,
      resumeSessionAt,
      developerInstructions,
    } = opts;
    const claimed = await claimSession(this.session.id, this.workerId);
    if (!claimed) {
      this.slotReleaseFuture.resolve();
      this.exitFuture.resolve(null);
      return;
    }

    // Continue seq from wherever the previous session run left off so that
    // event IDs remain monotonically increasing across resumes and the SSE
    // client never sees duplicate IDs.
    this.eventSeq = claimed.eventSeq;

    const logPath = resolveSessionLogPath(this.session.id);
    this.logWriter = new FileLogWriter(logPath);
    this.logWriter.open();

    this.dataPipeline = new SessionDataPipeline({
      sessionId: this.session.id,
      logWriter: this.logWriter,
      adapter: this.adapter,
      approvalHandler: this.approvalHandler,
      activityTracker: this.activityTracker,
      activeToolUseIds: this.activeToolUseIds,
      emitEvent: (payload) => this.emitEvent(payload),
      onEmittedEvent: (event) => this.onEmittedEvent(event),
      mapClaudeJson: (parsed, callbacks) =>
        mapClaudeJsonToEvents(parsed, {
          ...callbacks,
          onMessageStart: (stats) => {
            callbacks.onMessageStart?.(stats);
            // Emit real-time context bar update so the workspace header
            // updates mid-turn, not just after agent:result fires.
            if (this.dataPipeline.lastContextWindow) {
              const used =
                stats.inputTokens + stats.cacheReadInputTokens + stats.cacheCreationInputTokens;
              void this.emitEvent({
                type: 'agent:usage',
                used,
                size: this.dataPipeline.lastContextWindow,
              });
            }
          },
          onResultStats: (costUsd, turns) => {
            void db
              .update(sessions)
              .set({
                ...(costUsd !== null && { totalCostUsd: String(costUsd) }),
                ...(turns !== null && { totalTurns: turns }),
              })
              .where(eq(sessions.id, this.session.id))
              .catch((err: unknown) => {
                log.error({ err, sessionId: this.session.id }, 'cost stats update failed');
              });
          },
        }),
    });

    // Persist the log file path so the frontend can fetch it later.
    await db.update(sessions).set({ logFilePath: logPath }).where(eq(sessions.id, this.session.id));

    // Subscribe to control channel for inbound messages (send, cancel, redirect, tool-approval).
    this.unsubscribeControl = await subscribe(
      channelName('agendo_control', this.session.id),
      (payload) => {
        this.onControl(payload).catch((err: unknown) => {
          log.error({ err, sessionId: this.session.id }, 'Control handler error');
        });
      },
    );

    const childEnv = buildChildEnv(
      process.env,
      { sessionId: this.session.id, agentId: this.session.agentId, taskId: this.session.taskId },
      envOverrides,
    );

    // For Gemini sessions with the Agendo MCP server injected, write a temporary
    // TOML policy file that auto-allows all agendo MCP tools. This eliminates
    // unnecessary requestPermission calls for mcp__agendo__* tools even in
    // default mode. The file is cleaned up when the session exits.
    if (mcpServers?.some((s) => s.name === 'agendo')) {
      const policyToml =
        '[[rule]]\nmcpName = "agendo"\ntoolName = "*"\ndecision = "allow"\npriority = 200\n';
      this.policyFilePath = `/tmp/agendo-policy-${this.session.id}.toml`;
      writeFileSync(this.policyFilePath, policyToml, 'utf-8');
    }

    this.spawnCwd = spawnCwdOpt ?? '/tmp';
    const spawnOpts = buildSpawnOpts(this.session, this.spawnCwd, childEnv, {
      policyFilePath: this.policyFilePath ?? undefined,
      mcpConfigPath,
      mcpServers,
      initialImage,
      developerInstructions,
    });

    // Wire approval handler so adapter can request per-tool approval
    this.adapter.setApprovalHandler((req) => this.approvalHandler.handleApprovalRequest(req));

    // Wire pre-process context for Claude-specific NDJSON detection
    // (interactive tool failure check + assistant UUID capture).
    this.adapter.setPreProcessContext?.(
      (content, toolIds) => this.approvalHandler.checkForHumanResponseBlocks(content, toolIds),
      this.activeToolUseIds,
    );

    // Wire sessionRef callback so Codex/Gemini can persist their ref to DB
    // (Claude handles this via the session:init NDJSON event)
    this.adapter.onSessionRef?.((ref) => {
      this.sessionRef = ref;
      db.update(sessions)
        .set({ sessionRef: ref })
        .where(eq(sessions.id, this.session.id))
        .catch((err: unknown) => {
          log.error({ err, sessionId: this.session.id }, 'Failed to persist sessionRef');
        });
    });

    // Wire thinking callback for agent:activity events
    this.adapter.onThinkingChange((thinking) => {
      void this.emitEvent({ type: 'agent:activity', thinking });
      // When thinking stops, transition to awaiting_input (works for all adapters:
      // Claude handles it via agent:result; for Codex/Gemini this is the only signal).
      if (!thinking && !this.exitCtx.interruptInProgress) {
        void this.transitionTo('awaiting_input').then(() => this.activityTracker.recordActivity());
      }
    });

    // Determine how to start: fork (--resume --fork-session), resume (--resume), or spawn.
    // Fork path: the session has a forkSourceRef from a parent but no sessionRef yet,
    // meaning this is the very first start of a forked session.
    const forkSourceRef = this.session.forkSourceRef;
    const isForkStart = !!forkSourceRef && !this.session.sessionRef;

    if (isForkStart) {
      // First start of a forked session: resume parent's conversation in a new session.
      // Claude creates a fresh session ID, initialized from the parent's history.
      // No user:message event is emitted here — the InitialPromptBanner in the UI already
      // displays session.initialPrompt (the clean edited message). Emitting it would create
      // a duplicate bubble that also includes the MCP context preamble.
      //
      // IMPORTANT: --resume-session-at only works in -p (print) mode.
      // When resumeSessionAt is provided, force persistentSession=false so that
      // -p is added to the CLI invocation. Claude will exit after one response,
      // emit session:init (new fork sessionRef) + agent:result, and then the
      // session transitions to awaiting_input for subsequent persistent turns.
      this.managedProcess = this.adapter.resume(forkSourceRef, prompt, {
        ...spawnOpts,
        forkSession: true,
        resumeSessionAt,
        ...(resumeSessionAt ? { persistentSession: false } : {}),
      });
    } else if (resumeRef) {
      // Emit the user's prompt as a user:message event so it appears in the
      // session log and is replayed after a page refresh (cold-resume path).
      // Use displayText if provided so system preambles (e.g. [Previous Work Summary])
      // are not shown in the chat view.
      await this.emitEvent({ type: 'user:message', text: displayText ?? prompt });
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

    this.activityTracker.startHeartbeat();
    this.activityTracker.startMcpHealthCheck();

    // Attach team monitor immediately if a team exists on disk (cold-resume),
    // or wait for TeamCreate tool event (event-driven path).
    this.teamManager.start();
  }

  // ---------------------------------------------------------------------------
  // Private: process output handling
  // ---------------------------------------------------------------------------

  private async onData(chunk: string): Promise<void> {
    await this.dataPipeline.processChunk(chunk);
  }

  // ---------------------------------------------------------------------------
  // Private: post-emit event side-effects
  // ---------------------------------------------------------------------------

  /**
   * Process side-effects triggered by a newly emitted event.
   * Handles tool tracking, team lifecycle, session:init persistence,
   * context window caching, web tool usage persistence, and state transitions.
   */
  private async onEmittedEvent(event: AgendoEvent): Promise<void> {
    // Track in-flight tool calls to enable synthetic cleanup on cancel
    // and to build informative interruption notes on worker restart.
    if (event.type === 'agent:tool-start') {
      this.activeToolUseIds.add(event.toolUseId);
      this.activeToolInfo.set(event.toolUseId, {
        toolName: event.toolName,
        input: event.input,
      });
    }
    if (event.type === 'agent:tool-end') {
      this.activeToolUseIds.delete(event.toolUseId);
      this.activeToolInfo.delete(event.toolUseId);
    }

    // Detect TeamCreate / TeamDelete tool events for team lifecycle.
    if (event.type === 'agent:tool-start' || event.type === 'agent:tool-end') {
      this.teamManager.onToolEvent(event);
    }

    // Persist sessionRef and model once the agent announces its session ID.
    if (event.type === 'session:init') {
      const updates: Record<string, string> = {};
      if (event.sessionRef) {
        this.sessionRef = event.sessionRef;
        updates.sessionRef = event.sessionRef;
      }
      if (event.model) {
        updates.model = event.model;
      }
      if (Object.keys(updates).length > 0) {
        await db.update(sessions).set(updates).where(eq(sessions.id, this.session.id));
      }
    }

    // Cache context window size for real-time agent:usage emission on next message_start.
    if (event.type === 'agent:result' && event.modelUsage) {
      for (const usage of Object.values(event.modelUsage)) {
        if (usage.contextWindow) {
          this.dataPipeline.lastContextWindow = usage.contextWindow;
          break;
        }
      }
    }

    // Persist server-side tool usage counters (web_search/web_fetch) from Claude result.
    if (event.type === 'agent:result' && event.serverToolUse) {
      const { webSearchRequests, webFetchRequests } = event.serverToolUse;
      void db
        .update(sessions)
        .set({
          ...(webSearchRequests != null && { webSearchRequests }),
          ...(webFetchRequests != null && { webFetchRequests }),
        })
        .where(eq(sessions.id, this.session.id))
        .catch((err: unknown) => {
          log.error({ err, sessionId: this.session.id }, 'web tool usage update failed');
        });
    }

    // After the agent finishes a result, transition to awaiting_input.
    // Skip during an interrupt — handleInterrupt() manages the transition
    // based on whether the process survived (warm vs cold resume).
    if (event.type === 'agent:result' && !this.exitCtx.interruptInProgress) {
      await this.transitionTo('awaiting_input');
      this.activityTracker.recordActivity();
    }
  }

  // ---------------------------------------------------------------------------
  // Private: control channel handling
  // ---------------------------------------------------------------------------

  private async onControl(payload: string): Promise<void> {
    let control: AgendoControl;
    try {
      control = JSON.parse(payload) as AgendoControl;
    } catch {
      log.warn({ sessionId: this.session.id }, 'Malformed control payload');
      return;
    }

    const ctrl = this.makeCtrl();

    if (control.type === 'cancel') {
      await handleCancel(ctrl);
    } else if (control.type === 'interrupt') {
      await handleInterrupt(ctrl);
    } else if (control.type === 'message') {
      await handleMessage(control, ctrl);
    } else if (control.type === 'redirect') {
      await handleRedirect(control, ctrl);
    } else if (control.type === 'tool-approval') {
      await handleToolApproval(control, ctrl);
    } else if (control.type === 'tool-result') {
      await handleToolResult(control, ctrl, this.status);
    } else if (control.type === 'answer-question') {
      await handleAnswerQuestion(control, ctrl);
    } else if (control.type === 'set-permission-mode') {
      await handleSetPermissionMode(control.mode, ctrl);
    } else if (control.type === 'set-model') {
      await handleSetModel(control.model, ctrl);
    } else if (control.type === 'steer') {
      await handleSteer(control, ctrl);
    } else if (control.type === 'rollback') {
      await handleRollback(control, ctrl);
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
      log.warn(
        { sessionId: this.session.id, status: this.status },
        'pushMessage ignored — wrong session status',
      );
      return;
    }
    // Emit user message and transition to 'active' BEFORE calling sendMessage.
    // This is critical for the Gemini ACP adapter, whose sendMessage() blocks
    // until the full ACP roundtrip completes. If we transitioned after, the
    // thinkingCallback(false) that fires inside sendMessage would see status
    // still as 'awaiting_input' and the transitionTo('awaiting_input') would
    // be a no-op — leaving the session stuck in 'active' forever.
    await this.emitEvent({ type: 'user:message', text, hasImage: !!image });
    // Emit a compact-start indicator when the user manually triggers /compact.
    // Claude's stream gives no start signal — only a compact_boundary at the end.
    if (text.trim() === '/compact' || text.trim().startsWith('/compact ')) {
      await this.emitEvent({ type: 'system:compact-start', trigger: 'manual' });
    }
    await this.transitionTo('active');
    this.activityTracker.recordActivity();
    await this.adapter.sendMessage(text, image);
  }

  // ---------------------------------------------------------------------------
  // Private: control context factory
  // ---------------------------------------------------------------------------

  private makeCtrl(): SessionControlCtx {
    return {
      session: this.session,
      adapter: this.adapter,
      managedProcess: this.managedProcess,
      sigkillTimers: this.sigkillTimers,
      approvalHandler: this.approvalHandler,
      activityTracker: this.activityTracker,
      activeToolUseIds: this.activeToolUseIds,
      emitEvent: (p) => this.emitEvent(p),
      transitionTo: (s) => this.transitionTo(s),
      exitContext: this.exitCtx,
      pushMessage: (text, image) => this.pushMessage(text, image),
      makeCtrl: () => this.makeCtrl(),
    };
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
    this.activeToolInfo.clear();
    this.approvalHandler.clearSuppressed();
    this.approvalHandler.drain('deny');
    await this.adapter.interrupt();
    const t = setTimeout(() => {
      this.managedProcess?.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
    this.sigkillTimers.push(t);
  }

  // ---------------------------------------------------------------------------
  // Private: state transitions
  // ---------------------------------------------------------------------------

  private async transitionTo(status: SessionStatus): Promise<void> {
    if (this.status === status) return; // already in this state, skip duplicate transition
    this.status = status;

    // Flush any remaining text in the data buffer before entering awaiting_input.
    // Gemini's ACP adapter may not emit a trailing newline after the last text chunk,
    // leaving partial text stuck in the buffer. Without this flush, the user would
    // never see the final text fragment.
    if (status === 'awaiting_input') {
      const remaining = this.dataPipeline.flushBuffer();
      if (remaining.trim()) {
        await this.emitEvent({ type: 'agent:text', text: remaining.trim() });
      }
    }

    await db
      .update(sessions)
      .set({ status, lastActiveAt: new Date() })
      .where(eq(sessions.id, this.session.id));
    await this.emitEvent({ type: 'session:state', status });

    if (status === 'awaiting_input') {
      // Drain any team messages that arrived while Claude was active.
      this.teamManager.drainPendingInjections();

      const elapsedSec = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);
      log.info({ sessionId: this.session.id, elapsedSec }, 'awaiting_input — slot released');
      // Session completed a turn — reset the zombie recovery counter so it
      // doesn't count previous restarts against future auto-recovery attempts.
      resetRecoveryCount(this.session.id);
      // Resolve the slot future so the pg-boss slot frees while the process
      // stays alive in-memory awaiting the next user message.
      this.slotReleaseFuture.resolve();
      // Notify subscribed browsers that the agent is ready for input
      void sendPushToAll({
        title: 'Agent finished',
        body: 'Your agent is ready for the next message',
        url: `/sessions/${this.session.id}`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: process exit
  // ---------------------------------------------------------------------------

  private async onExit(exitCode: number | null): Promise<void> {
    // Guard against double-invocation: the heartbeat liveness check and the
    // real process exit handler can both call onExit. The second call must be
    // a no-op to prevent double-releasing the PG pool client.
    if (this.exitCtx.exitHandled) return;
    this.exitCtx.exitHandled = true;

    const totalSec = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);
    log.info(
      { sessionId: this.session.id, exitCode, status: this.status, totalSec },
      'Session exited',
    );
    // Resolve the slot future in case the process exits before ever reaching
    // awaiting_input (e.g. error, cancellation). Safe to call if already resolved.
    this.slotReleaseFuture.resolve();

    cleanupResources({
      activityTracker: this.activityTracker,
      sigkillTimers: this.sigkillTimers,
      approvalHandler: this.approvalHandler,
      teamManager: this.teamManager,
      policyFilePath: this.policyFilePath,
      unsubscribeControl: this.unsubscribeControl,
    });
    this.unsubscribeControl = null;
    this.policyFilePath = null;

    // Map ActivityTracker flags to ExitContext reasons for the extracted determineExitStatus.
    if (this.activityTracker.idleTimeoutKilled && this.exitCtx.reason === 'none') {
      this.exitCtx.reason = 'idle-timeout';
    }
    if (this.activityTracker.interruptKilled && this.exitCtx.reason === 'none') {
      this.exitCtx.reason = 'interrupt';
    }

    // Capture mid-turn state BEFORE status transitions, for use in auto-resume below.
    const wasInterruptedMidTurn = this.exitCtx.terminateKilled && this.status === 'active';

    await determineExitStatus(this.exitCtx, exitCode, wasInterruptedMidTurn, {
      sessionId: this.session.id,
      taskId: this.session.taskId,
      agentId: this.session.agentId,
      currentStatus: this.status,
      activeToolInfo: this.activeToolInfo,
      emitEvent: (p) => this.emitEvent(p),
      transitionTo: (s) => this.transitionTo(s),
    });

    handleReEnqueue(
      {
        sessionId: this.session.id,
        sessionRef: this.sessionRef,
        dbSessionRef: this.session.sessionRef ?? null,
        exitContext: this.exitCtx,
      },
      wasInterruptedMidTurn,
    );

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
  private async emitEvent(partial: AgendoEventPayload): Promise<AgendoEvent> {
    const seq = ++this.eventSeq;

    // Keep eventSeq in sync on the session row so SSE reconnects know
    // how many events have been emitted without reading the log file.
    await db.update(sessions).set({ eventSeq: seq }).where(eq(sessions.id, this.session.id));

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
  // Public: wait for process completion
  // ---------------------------------------------------------------------------

  /**
   * Returns a promise that resolves with the process exit code once the
   * session terminates. Useful for the worker to await job completion.
   */
  waitForExit(): Promise<number | null> {
    return this.exitFuture.promise;
  }

  /**
   * Returns a promise that resolves when the pg-boss slot should be freed.
   * Resolves on the first `awaiting_input` transition (process stays alive in
   * memory) or on process exit — whichever comes first.
   *
   * The session-runner uses this instead of waitForExit() so that the pg-boss
   * slot is released immediately once the agent is idle, preventing slot drain
   * from sessions stuck in awaiting_input.
   */
  waitForSlotRelease(): Promise<void> {
    return this.slotReleaseFuture.promise;
  }

  /**
   * Send SIGTERM to the underlying agent process for graceful shutdown.
   * Used during worker shutdown to terminate live sessions that are awaiting input.
   */
  terminate(): void {
    // Set reason BEFORE sending SIGTERM so onExit transitions to 'idle' (resumable)
    // instead of 'ended'. This allows cold-resume after a graceful worker restart.
    this.exitCtx.reason = 'terminate';
    this.managedProcess?.kill('SIGTERM');
  }

  /**
   * Mark this session as intentionally terminated by the worker, WITHOUT
   * sending a signal. Used at the very start of shutdown() — synchronously,
   * before any await — to ensure terminateKilled is true before onExit fires.
   *
   * Needed because SIGINT (Ctrl-C / pm2 restart) is delivered to the whole
   * process group: Claude exits concurrently with our shutdown handler, so
   * we must set the flag before the I/O event loop tick that fires onExit.
   */
  markTerminating(): void {
    this.exitCtx.reason = 'terminate';
  }
}
