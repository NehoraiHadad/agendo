import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { persistContextWindow } from '@/lib/worker/context-window-cache';
import { db } from '@/lib/db';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-process');
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { config } from '@/lib/config';
import { sessionEventListeners } from '@/lib/worker/worker-sse';
import { serializeEvent } from '@/lib/realtime/events';
import type {
  AgendoEvent,
  AgendoEventPayload,
  AgendoControl,
  SessionStatus,
  MessagePriority,
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
  handleSteer,
  handleRollback,
  handleCancelQueued,
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
// resetRecoveryCount is now folded into transitionTo's DB update (autoResumeCount: 0)
import { ApprovalHandler } from '@/lib/worker/approval-handler';
import { ActivityTracker } from '@/lib/worker/activity-tracker';
import type { InFlightTool } from '@/lib/worker/interruption-marker';
import {
  ExitContext,
  cleanupResources,
  determineExitStatus,
} from '@/lib/worker/session-exit-logic';
import { SessionDataPipeline } from '@/lib/worker/session-data-pipeline';
import { captureGitContext, countCommitsSince } from '@/lib/worker/git-context';
import type { GitContextSnapshot } from '@/lib/realtime/event-types';

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
  private exitCtx = new ExitContext();
  /** Stored cwd for plan file reading during clearContextRestart. */
  private spawnCwd: string | null = null;
  /** SIGKILL escalation timers — tracked so they can be cleared if the process exits early. */
  private sigkillTimers: ReturnType<typeof setTimeout>[] = [];
  private eventSeq = 0;
  private status: SessionStatus = 'active';
  private sessionRef: string | null = null;
  /**
   * True when Claude failed with "No conversation found" during a resume attempt.
   * The JSONL had no actual conversation history — only queue-operations written
   * before the worker crashed mid-first-turn. Triggers a fresh spawn in onExit.
   */
  private conversationNotFound = false;
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
  /** Git commit hash at session start, used to compute commitsSinceStart on subsequent snapshots. */
  private initialGitHash: string | null = null;
  /** Latest git context snapshot — included in getLiveState() so SSE reconnects restore the badge. */
  private lastGitSnapshot: import('@/lib/realtime/event-types').GitContextSnapshot | null = null;
  /** ISO timestamp when lastGitSnapshot was captured — preserved for accurate reconnect replays. */
  private lastGitSnapshotAt: string | null = null;
  /** Debounce timer for flushing eventSeq to DB. */
  private seqFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last eventSeq value that was persisted to DB. */
  private seqFlushedValue = 0;

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
      // publishTextDelta: emit agent:text-delta to in-memory SSE listeners (no log write, no DB)
      async (text) => {
        const event: AgendoEvent = {
          id: ++this.eventSeq,
          sessionId: this.session.id,
          ts: Date.now(),
          type: 'agent:text-delta',
          text,
        };
        const listeners = sessionEventListeners.get(this.session.id);
        if (listeners) {
          for (const cb of listeners) {
            try {
              cb(event);
            } catch {
              /* ignore */
            }
          }
        }
      },
      // publishThinkingDelta: emit agent:thinking-delta to in-memory SSE listeners
      async (text) => {
        const event: AgendoEvent = {
          id: ++this.eventSeq,
          sessionId: this.session.id,
          ts: Date.now(),
          type: 'agent:thinking-delta',
          text,
        };
        const listeners = sessionEventListeners.get(this.session.id);
        if (listeners) {
          for (const cb of listeners) {
            try {
              cb(event);
            } catch {
              /* ignore */
            }
          }
        }
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
      sdkMcpServers,
      mcpServers,
      initialImage,
      displayText,
      displayClientId,
      resumeSessionAt,
      developerInstructions,
      appendSystemPrompt,
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
      activeToolUseIds: this.activeToolUseIds,
      emitEvent: (payload) => this.emitEvent(payload),
      onEmittedEvent: (event) => this.onEmittedEvent(event),
    });

    // Persist the log file path so the frontend can fetch it later.
    await db.update(sessions).set({ logFilePath: logPath }).where(eq(sessions.id, this.session.id));

    // Start the heartbeat as early as possible — right after claim succeeds.
    // Control messages are now delivered via Worker HTTP (port 4102) instead of
    // PG NOTIFY, so there is no subscribe() call here.
    // ActivityTracker skips the PID liveness check when getPid() returns null,
    // so starting the heartbeat before the process exists is safe.
    this.activityTracker.startHeartbeat();

    // Emit an explicit session:state { active } event so the frontend always
    // transitions to "Active" when a session starts (or cold-resumes).
    // claimSession() already set the DB to 'active', but it doesn't publish
    // to PG NOTIFY. transitionTo('active') would be a no-op here because
    // this.status is pre-initialized to 'active' (the duplicate-guard fires).
    // Emitting directly ensures connected browsers see the status change
    // regardless of whether this is a fresh spawn, cold-resume, or fork-start.
    await this.emitEvent({ type: 'session:state', status: 'active' });

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

    // Capture point A: git context at session start (blocking — process not spawned yet)
    const gitSnapshot = await captureGitContext(this.spawnCwd);
    if (gitSnapshot) {
      this.initialGitHash = gitSnapshot.commitHash;
      this.lastGitSnapshot = this.toEventSnapshot(gitSnapshot);
      this.lastGitSnapshotAt = new Date().toISOString();
      await this.emitEvent({
        type: 'system:git-context',
        snapshot: this.lastGitSnapshot,
        capturedAt: this.lastGitSnapshotAt,
        trigger: 'start',
      });
    }

    const spawnOpts = buildSpawnOpts(this.session, this.spawnCwd, childEnv, {
      policyFilePath: this.policyFilePath ?? undefined,
      mcpConfigPath,
      sdkMcpServers,
      mcpServers,
      initialImage,
      developerInstructions,
      appendSystemPrompt,
    });

    // Wire approval handler so adapter can request per-tool approval
    this.adapter.setApprovalHandler((req) => this.approvalHandler.handleApprovalRequest(req));

    // Wire activity callbacks for SDK adapters that handle stream_event delta buffering
    // internally (e.g. ClaudeSdkAdapter). The adapter uses these to flush text/thinking
    // deltas and persist cost stats — bypassing the NDJSON pipeline's callback path.
    this.adapter.setActivityCallbacks?.({
      clearDeltaBuffers: () => this.activityTracker.clearDeltaBuffers(),
      appendDelta: (text) => this.activityTracker.appendDelta(text),
      appendThinkingDelta: (text) => this.activityTracker.appendThinkingDelta(text),
      onMessageStart: (stats) => {
        // Store per-call stats so enrichResultPayload attaches them to agent:result.
        // Without this, the UI falls back to aggregated modelUsage which inflates
        // the context bar for multi-tool-call turns.
        this.dataPipeline.setPerCallContextStats(stats);

        // Emit real-time context bar update when a new API call starts.
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
    });

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
      if (thinking) {
        // Agent started thinking → ensure DB reflects active work.
        // This handles the case where system:init (or another event) previously
        // transitioned us to awaiting_input before the agent had started its turn.
        if (this.status === 'awaiting_input') {
          void this.transitionTo('active');
        }
      } else if (!this.exitCtx.interruptInProgress) {
        // When thinking stops, transition to awaiting_input (works for all adapters:
        // Claude handles it via agent:result; for Codex/Gemini this is the only signal).
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
      this.managedProcess = this.adapter.resume(forkSourceRef, prompt, {
        ...spawnOpts,
        forkSession: true,
        resumeSessionAt,
      });
    } else if (resumeRef) {
      // Emit the user's prompt as a user:message event so it appears in the
      // session log and is replayed after a page refresh (cold-resume path).
      // Use displayText if provided so system preambles (e.g. [Previous Work Summary])
      // are not shown in the chat view.
      await this.emitEvent({
        type: 'user:message',
        text: displayText ?? prompt,
        ...(displayClientId && { clientId: displayClientId }),
      });
      this.managedProcess = this.adapter.resume(resumeRef, prompt, spawnOpts);
    } else {
      this.managedProcess = this.adapter.spawn(prompt, spawnOpts);
    }

    // Persist PID for SIGTERM/SIGKILL from other paths (e.g. API cancel endpoint).
    // ManagedProcess.pid is null for in-process adapters (e.g. ClaudeSdkAdapter).
    await db
      .update(sessions)
      .set({ pid: this.managedProcess.pid })
      .where(eq(sessions.id, this.session.id));

    // Wire process output and exit handlers.
    // onData: NDJSON stdout path for CLI adapters (Codex, Gemini).
    // onEvents: direct typed-payload path for SDK adapters (Claude SDK) — bypasses
    //           NDJSON buffering/parsing and routes straight to processEvents().
    this.managedProcess.onData((chunk) => void this.onData(chunk));
    this.managedProcess.onEvents?.((payloads) => void this.dataPipeline.processEvents(payloads));
    this.managedProcess.onExit((code) => void this.onExit(code));

    // Heartbeat was already started before subscribe() — don't call it again.
    // Start MCP health check now that the process is alive and MCP servers are connected.
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

    // Persist sessionRef locally (needed for re-enqueue on exit).
    if (event.type === 'session:init' && event.sessionRef) {
      this.sessionRef = event.sessionRef;
    }

    // Detect Claude SDK "No conversation found" resume failure.
    // This happens when a worker crashed mid-first-turn: the JSONL exists but
    // contains only queue-operations with no actual conversation history.
    // Clear the invalid sessionRef immediately so onExit can restart fresh.
    if (
      event.type === 'agent:result' &&
      event.isError &&
      event.errors?.some((e) => e.includes('No conversation found'))
    ) {
      this.conversationNotFound = true;
      this.sessionRef = null;
      db.update(sessions)
        .set({ sessionRef: null })
        .where(eq(sessions.id, this.session.id))
        .catch((err: unknown) => {
          log.error({ err, sessionId: this.session.id }, 'Failed to clear invalid sessionRef');
        });
    }

    // Persist DB side-effects (sessionRef, model, web tool usage counters).
    await this.dataPipeline.persistEventSideEffects(event);

    // Cache context window size for real-time agent:usage emission on next message_start.
    // Also persist to disk so offline tools (measure.py) can use the real value.
    if (event.type === 'agent:result' && event.modelUsage) {
      for (const [modelId, usage] of Object.entries(event.modelUsage)) {
        if (usage.contextWindow) {
          this.dataPipeline.lastContextWindow = usage.contextWindow;
          persistContextWindow(modelId, usage.contextWindow);
          break;
        }
      }
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

  public async onControl(payload: string): Promise<void> {
    let control: AgendoControl;
    try {
      control = JSON.parse(payload) as AgendoControl;
    } catch {
      log.warn({ sessionId: this.session.id }, 'Malformed control payload');
      return;
    }

    log.debug(
      { sessionId: this.session.id, type: control.type, status: this.status },
      'Control message received',
    );

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
    } else if (control.type === 'set-permission-mode') {
      await handleSetPermissionMode(control.mode, ctrl);
    } else if (control.type === 'set-model') {
      await handleSetModel(control.model, ctrl);
    } else if (control.type === 'steer') {
      await handleSteer(control, ctrl);
    } else if (control.type === 'rollback') {
      await handleRollback(control, ctrl);
    } else if (control.type === 'cancel-queued') {
      await handleCancelQueued(control, ctrl);
    } else if (control.type === 'mcp-set-servers') {
      if (ctrl.adapter.setMcpServers) {
        const result = await ctrl.adapter.setMcpServers(control.servers);
        await ctrl.emitEvent({
          type: 'system:info',
          message: `MCP servers updated: ${JSON.stringify(result)}`,
        });
      }
    } else if (control.type === 'mcp-reconnect') {
      if (ctrl.adapter.reconnectMcpServer) {
        await ctrl.adapter.reconnectMcpServer(control.serverName);
        await ctrl.emitEvent({
          type: 'system:info',
          message: `MCP server '${control.serverName}' reconnected`,
        });
      }
    } else if (control.type === 'mcp-toggle') {
      if (ctrl.adapter.toggleMcpServer) {
        await ctrl.adapter.toggleMcpServer(control.serverName, control.enabled);
        await ctrl.emitEvent({
          type: 'system:info',
          message: `MCP server '${control.serverName}' ${control.enabled ? 'enabled' : 'disabled'}`,
        });
      }
    } else if (control.type === 'rewind-files') {
      if (ctrl.adapter.rewindFiles) {
        const result = await ctrl.adapter.rewindFiles(control.userMessageId, control.dryRun);
        await ctrl.emitEvent({
          type: 'system:info',
          message: `Rewind files result: ${JSON.stringify(result)}`,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public: send a message to the running agent
  // ---------------------------------------------------------------------------

  /**
   * Retrieve conversation history from the CLI's native storage.
   * Delegates to adapter.getHistory() — used as a fallback when the
   * Agendo log file is missing or empty.
   *
   * Returns AgendoEventPayload[] or null if the adapter doesn't support
   * history retrieval (e.g. Gemini/Copilot) or the call fails.
   */
  async getHistory(): Promise<AgendoEventPayload[] | null> {
    if (!this.adapter.getHistory) return null;
    return this.adapter.getHistory(
      this.sessionRef ?? this.session.sessionRef ?? '',
      this.spawnCwd ?? undefined,
    );
  }

  /**
   * Retrieve Agendo-specific state from live sources for SSE reconnect catchup.
   *
   * Returns events that CLI-native history (adapter.getHistory()) doesn't include:
   *   - session:init (synthesized from DB fields)
   *   - team:config, team:message, team:task-update, team:outbox-message (from filesystem)
   *
   * This replaces the previous approach of parsing the log file for these events.
   * The log file remains as a fallback for ended sessions with no live process.
   */
  getLiveState(): AgendoEventPayload[] {
    const events: AgendoEventPayload[] = [];

    // 1. Synthesize session:init from DB fields + in-memory state
    if (this.session.sessionRef || this.sessionRef) {
      events.push({
        type: 'session:init',
        sessionRef: this.sessionRef ?? this.session.sessionRef ?? '',
        model: this.session.model ?? undefined,
        permissionMode: this.session.permissionMode ?? undefined,
        slashCommands: [],
        mcpServers: [],
      });
    }

    // 2. Team state from live filesystem sources
    events.push(...this.teamManager.getTeamState());

    // 3. Latest git context snapshot (persists across SSE reconnects)
    if (this.lastGitSnapshot && this.lastGitSnapshotAt) {
      events.push({
        type: 'system:git-context',
        snapshot: this.lastGitSnapshot,
        capturedAt: this.lastGitSnapshotAt,
        trigger: 'reconnect',
      });
    }

    return events;
  }

  /**
   * Push a user message to the running agent process.
   * Only valid when the session is active or awaiting_input.
   */
  async pushMessage(
    text: string,
    opts?: { image?: ImageContent; priority?: MessagePriority; clientId?: string },
  ): Promise<void> {
    const { image, priority, clientId } = opts ?? {};
    if (!['active', 'awaiting_input'].includes(this.status)) {
      log.warn(
        { sessionId: this.session.id, status: this.status },
        'pushMessage ignored — wrong session status',
      );
      return;
    }
    // If priority is 'now', interrupt the current turn first so the message
    // is processed immediately. The SDK dequeues 'now' messages first, but
    // interruption is needed to stop the in-flight turn.
    if (priority === 'now') {
      await this.adapter.interrupt();
    }
    // Emit user message and transition to 'active' BEFORE calling sendMessage.
    // This is critical for the Gemini ACP adapter, whose sendMessage() blocks
    // until the full ACP roundtrip completes. If we transitioned after, the
    // thinkingCallback(false) that fires inside sendMessage would see status
    // still as 'awaiting_input' and the transitionTo('awaiting_input') would
    // be a no-op — leaving the session stuck in 'active' forever.
    await this.emitEvent({
      type: 'user:message',
      text,
      hasImage: !!image,
      ...(clientId && { clientId }),
    });
    // Emit a compact-start indicator when the user manually triggers /compact.
    // Claude's stream gives no start signal — only a compact_boundary at the end.
    if (text.trim() === '/compact' || text.trim().startsWith('/compact ')) {
      await this.emitEvent({ type: 'system:compact-start', trigger: 'manual' });
    }
    await this.transitionTo('active');
    this.activityTracker.recordActivity();
    await this.adapter.sendMessage(text, image, priority, clientId);
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
      pushMessage: (text, opts) => this.pushMessage(text, opts),
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
      .set({
        status,
        lastActiveAt: new Date(),
        // Reset the durable auto-resume counter on successful turn completion.
        // This ensures previous crash-recovery attempts don't count against
        // future auto-recovery. Folded into this single DB write for atomicity.
        ...(status === 'awaiting_input' && { autoResumeCount: 0 }),
      })
      .where(eq(sessions.id, this.session.id));
    // Flush eventSeq immediately on status transitions so reconnecting clients
    // can resume from the correct position when the session status changes.
    this.flushSeqNow();
    await this.emitEvent({ type: 'session:state', status });

    if (status === 'awaiting_input') {
      // Drain any team messages that arrived while Claude was active.
      this.teamManager.drainPendingInjections();

      // Capture point B: git context at turn end (non-blocking)
      if (this.spawnCwd) {
        captureGitContext(this.spawnCwd)
          .then(async (snap) => {
            if (snap) {
              const eventSnap = this.toEventSnapshot(snap);
              if (this.initialGitHash) {
                eventSnap.commitsSinceStart = await countCommitsSince(
                  this.initialGitHash,
                  this.spawnCwd ?? process.cwd(),
                );
              }
              this.lastGitSnapshot = eventSnap;
              this.lastGitSnapshotAt = new Date().toISOString();
              void this.emitEvent({
                type: 'system:git-context',
                snapshot: eventSnap,
                capturedAt: this.lastGitSnapshotAt,
                trigger: 'turn_end',
              });
            }
          })
          .catch(() => {}); // non-critical — don't fail the transition
      }

      const elapsedSec = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);
      log.info({ sessionId: this.session.id, elapsedSec }, 'awaiting_input — slot released');
      // autoResumeCount already reset to 0 in the DB update above (folded into
      // the same write for atomicity). No separate resetRecoveryCount call needed.
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

    // Capture point C: git context at session exit (non-blocking)
    if (this.spawnCwd) {
      try {
        const snap = await captureGitContext(this.spawnCwd);
        if (snap) {
          const eventSnap = this.toEventSnapshot(snap);
          if (this.initialGitHash) {
            eventSnap.commitsSinceStart = await countCommitsSince(
              this.initialGitHash,
              this.spawnCwd,
            );
          }
          await this.emitEvent({
            type: 'system:git-context',
            snapshot: eventSnap,
            capturedAt: new Date().toISOString(),
            trigger: 'exit',
          });
        }
      } catch {
        // non-critical — don't let git failures block session exit
      }
    }

    cleanupResources({
      activityTracker: this.activityTracker,
      sigkillTimers: this.sigkillTimers,
      approvalHandler: this.approvalHandler,
      teamManager: this.teamManager,
      policyFilePath: this.policyFilePath,
    });
    this.policyFilePath = null;

    // Map ActivityTracker flags to ExitContext reasons for the extracted determineExitStatus.
    if (this.activityTracker.idleTimeoutKilled && this.exitCtx.reason === 'none') {
      this.exitCtx.reason = 'idle-timeout';
    }
    if (this.activityTracker.interruptKilled && this.exitCtx.reason === 'none') {
      this.exitCtx.reason = 'interrupt';
    }

    // Capture mid-turn state BEFORE status transitions, for use in auto-resume below.
    // Covers both planned terminations (terminateKilled) and unexpected crashes
    // (non-zero exit, no known reason) — e.g. agendo restart dropping the MCP
    // connection while the agent was actively working.
    const wasInterruptedMidTurn =
      this.status === 'active' &&
      !this.exitCtx.cancelKilled &&
      (this.exitCtx.terminateKilled ||
        (exitCode !== 0 && exitCode !== null && this.exitCtx.reason === 'none'));

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
        conversationNotFound: this.conversationNotFound,
        initialPrompt: this.session.initialPrompt,
      },
      wasInterruptedMidTurn,
    );

    // Cancel debounced flush timer and do a final immediate flush so the DB
    // has the correct eventSeq before the session is considered done.
    if (this.seqFlushTimer !== null) {
      clearTimeout(this.seqFlushTimer);
      this.seqFlushTimer = null;
    }
    this.flushSeqNow();

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
   * Debounced flush of eventSeq to the sessions DB row.
   * Batches multiple rapid event emissions into one DB write every 5 seconds,
   * instead of one write per event.
   */
  private debouncedSeqFlush(): void {
    if (this.seqFlushTimer !== null) return; // already scheduled
    this.seqFlushTimer = setTimeout(() => {
      this.seqFlushTimer = null;
      void this.flushSeqNow();
    }, 5_000);
  }

  /**
   * Immediately persist the current eventSeq to DB.
   * Called on status transitions and session exit to ensure the DB is up-to-date
   * before SSE reconnects read the eventSeq field.
   */
  private flushSeqNow(): void {
    const current = this.eventSeq;
    if (current === this.seqFlushedValue) return;
    this.seqFlushedValue = current;
    db.update(sessions)
      .set({ eventSeq: current })
      .where(eq(sessions.id, this.session.id))
      .catch((err: unknown) => {
        log.warn({ err, sessionId: this.session.id }, 'Failed to flush eventSeq to DB');
      });
  }

  /**
   * Assign a monotonic sequence number, notify in-memory SSE listeners,
   * and write the event to the session log file for replay on reconnect.
   *
   * DB eventSeq is updated via a debounced flush (every 5s) rather than
   * per-event to avoid one DB write per event on the hot path.
   *
   * Returns the fully constructed AgendoEvent for downstream use.
   */
  private async emitEvent(partial: AgendoEventPayload): Promise<AgendoEvent> {
    const seq = ++this.eventSeq;
    this.debouncedSeqFlush();

    const event = {
      id: seq,
      sessionId: this.session.id,
      ts: Date.now(),
      ...partial,
    } as AgendoEvent;

    // Notify all in-memory SSE listeners (browser tabs connected to Worker SSE).
    const listeners = sessionEventListeners.get(this.session.id);
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb(event);
        } catch {
          // Individual listener error — don't break others
        }
      }
    }

    // Write the structured event line to the session log file (optional audit trail).
    // CLI-native history (adapter.getHistory()) is now the primary source for SSE catchup.
    // Log file is the fallback for agents without getHistory() support (Gemini, Copilot).
    //
    // NOTE: agent:text-delta and agent:thinking-delta are intentionally excluded from
    // the log. They are high-frequency ephemeral streaming events — logging them causes
    // two problems for ACP agents (Gemini/Copilot) that rely on the log file for SSE
    // catchup: (1) hundreds of tiny fragments arrive as a wall of text on reconnect
    // instead of streaming, (2) they inflate log size significantly with no benefit
    // since the complete text arrives in the subsequent agent:result anyway.
    if (
      config.LOG_EVENTS &&
      this.logWriter &&
      event.type !== 'agent:text-delta' &&
      event.type !== 'agent:thinking-delta'
    ) {
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
   * Map the worker's GitContextSnapshot (from git-context.ts) to the event-types
   * GitContextSnapshot used in system:git-context events.
   */
  private toEventSnapshot(
    snap: import('@/lib/worker/git-context').GitContextSnapshot,
  ): GitContextSnapshot {
    return {
      branch: snap.branch,
      commitHash: snap.commitHash,
      commitMessage: snap.commitMessage,
      isDirty: snap.isDirty,
      isWorktree: snap.isWorktree,
      worktreeMainPath: snap.worktreeMainPath,
      baseBranch: snap.baseBranch,
      untrackedCount: snap.untracked.length,
      stagedFiles: snap.staged,
      modifiedFiles: snap.modified,
      aheadBehind: snap.aheadBehind,
    };
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
