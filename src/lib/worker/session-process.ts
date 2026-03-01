import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
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
import { enqueueSession } from '@/lib/worker/queue';
import { sendPushToAll } from '@/lib/services/notification-service';
import { SessionTeamManager } from '@/lib/worker/session-team-manager';
import { capturePlanFilePath, readPlanFromFile } from '@/lib/worker/session-plan-utils';
import {
  SIGKILL_DELAY_MS,
  handleCancel,
  handleInterrupt,
  handleSetPermissionMode,
  handleSetModel,
  type SessionControlCtx,
} from '@/lib/worker/session-control-handlers';
import type {
  AgentAdapter,
  SpawnOpts,
  ManagedProcess,
  ImageContent,
  PermissionDecision,
  AcpMcpServer,
} from '@/lib/worker/adapters/types';
import type { Session } from '@/lib/types';
import { Future } from '@/lib/utils/future';
import { resetRecoveryCount } from '@/worker/zombie-reconciler';
import { ApprovalHandler } from '@/lib/worker/approval-handler';
import { ActivityTracker } from '@/lib/worker/activity-tracker';
import { mapClaudeJsonToEvents } from '@/lib/worker/adapters/claude-event-mapper';

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
  private interruptInProgress = false;
  /** Set by terminate() so onExit transitions to 'idle' (resumable) instead of 'ended'. */
  private terminateKilled = false;
  /** Set by handleCancel() so onExit skips the "unexpected exit" error message. */
  private cancelKilled = false;
  /** Set by handleSetPermissionMode() so onExit re-enqueues for immediate restart. */
  private modeChangeRestart = false;
  /** Set by clearContextRestart (ExitPlanMode option 1): deny tool, kill, restart fresh. */
  private clearContextRestart = false;
  /** Stored cwd for plan file reading during clearContextRestart. */
  private spawnCwd: string | null = null;
  /** SIGKILL escalation timers — tracked so they can be cleared if the process exits early. */
  private sigkillTimers: ReturnType<typeof setTimeout>[] = [];
  private eventSeq = 0;
  private status: SessionStatus = 'active';
  private sessionRef: string | null = null;
  private dataBuffer = '';
  private exitFuture = new Future<number | null>();
  /** Resolves when the pg-boss slot should be freed: either on first awaiting_input
   *  transition or on process exit — whichever comes first. */
  private slotReleaseFuture = new Future<void>();
  private exitHandled = false;
  private sessionStartTime = Date.now();
  private activeToolUseIds = new Set<string>();
  /** Manages per-tool approval gates, interactive tool responses, and suppressed tool tracking. */
  private approvalHandler!: ApprovalHandler;
  /** Manages idle timer, heartbeat, MCP health check, and delta buffers. */
  private activityTracker!: ActivityTracker;
  /** Manages team inbox monitoring and TeamCreate/Delete lifecycle. */
  private teamManager!: SessionTeamManager;

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
   *
   * @param prompt - The initial prompt to pass to the agent
   * @param resumeRef - If provided, the adapter resumes an existing session
   * @param spawnCwd - Working directory for the spawned process
   * @param envOverrides - Additional env vars to merge into the child environment
   * @param mcpConfigPath - Optional path to a pre-generated MCP JSON config file.
   *   When provided, `--mcp-config <path>` is appended to the agent spawn args.
   * @param mcpServers - Optional MCP server list for ACP session/new (Gemini).
   * @param initialImage - Optional image attachment for cold resume.
   * @param displayText - Optional override for the user:message event text. When
   *   provided (e.g. on cold resume), only this text is shown in the chat view
   *   instead of the full prompt (which may contain system context preambles).
   */
  async start(
    prompt: string,
    resumeRef?: string,
    spawnCwd?: string,
    envOverrides?: Record<string, string>,
    mcpConfigPath?: string,
    mcpServers?: AcpMcpServer[],
    initialImage?: ImageContent,
    displayText?: string,
  ): Promise<void> {
    // Atomic claim: prevent double-execution on pg-boss retry.
    // Only claim from 'idle' or 'ended' — never from 'active'. The zombie
    // reconciler always resets orphaned 'active' sessions back to 'idle' before
    // re-enqueueing, so a legitimate resume always starts from 'idle'. Allowing
    // 'active' here caused a double-claim race: the retried old job and the
    // reconciler's new job both claimed the same session concurrently.
    const [claimed] = await db
      .update(sessions)
      .set({
        status: 'active',
        workerId: this.workerId,
        startedAt: new Date(),
        heartbeatAt: new Date(),
      })
      .where(and(eq(sessions.id, this.session.id), inArray(sessions.status, ['idle', 'ended'])))
      .returning({ id: sessions.id, eventSeq: sessions.eventSeq });

    if (!claimed) {
      console.log(`[session-process] Session ${this.session.id} already claimed — skipping`);
      // Resolve futures so callers don't hang indefinitely.
      this.slotReleaseFuture.resolve();
      this.exitFuture.resolve(null);
      return;
    }

    console.log(`[session-process] claimed session ${this.session.id} workerId=${this.workerId}`);

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
    await db.update(sessions).set({ logFilePath: logPath }).where(eq(sessions.id, this.session.id));

    // Subscribe to control channel for inbound messages (send, cancel, redirect, tool-approval).
    this.unsubscribeControl = await subscribe(
      channelName('agendo_control', this.session.id),
      (payload) => {
        this.onControl(payload).catch((err: unknown) => {
          console.error(
            `[session-process] Control handler error for session ${this.session.id}:`,
            err,
          );
        });
      },
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

    this.spawnCwd = spawnCwd ?? '/tmp';
    const spawnOpts: SpawnOpts = {
      cwd: this.spawnCwd,
      env: childEnv,
      executionId: this.session.id,
      timeoutSec: this.session.idleTimeoutSec,
      maxOutputBytes: 10 * 1024 * 1024,
      persistentSession: true, // keep process alive after result for multi-turn
      permissionMode: this.session.permissionMode ?? 'default',
      allowedTools: this.session.allowedTools ?? [],
      ...(mcpConfigPath ? { extraArgs: ['--mcp-config', mcpConfigPath] } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(initialImage ? { initialImage } : {}),
      // Sync Claude's session ID with agendo's DB session ID
      sessionId: this.session.id,
      // Only use our MCP servers when an MCP config is provided
      strictMcpConfig: !!mcpConfigPath,
      // Forward model if set on the session (e.g. from DB or API)
      ...(this.session.model ? { model: this.session.model } : {}),
      // TODO: wire maxBudgetUsd and fallbackModel when session config supports them
    };

    // Wire approval handler so adapter can request per-tool approval
    this.adapter.setApprovalHandler((req) => this.approvalHandler.handleApprovalRequest(req));

    // Wire sessionRef callback so Codex/Gemini can persist their ref to DB
    // (Claude handles this via the session:init NDJSON event)
    this.adapter.onSessionRef?.((ref) => {
      this.sessionRef = ref;
      db.update(sessions)
        .set({ sessionRef: ref })
        .where(eq(sessions.id, this.session.id))
        .catch((err: unknown) => {
          console.error(
            `[session-process] Failed to persist sessionRef for session ${this.session.id}:`,
            err,
          );
        });
    });

    // Wire thinking callback for agent:activity events
    this.adapter.onThinkingChange((thinking) => {
      void this.emitEvent({ type: 'agent:activity', thinking });
      // When thinking stops, transition to awaiting_input (works for all adapters:
      // Claude handles it via agent:result; for Codex/Gemini this is the only signal).
      if (!thinking && !this.interruptInProgress) {
        void this.transitionTo('awaiting_input').then(() => this.activityTracker.recordActivity());
      }
    });

    if (resumeRef) {
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
    // Write raw chunk to the session log file under the 'stdout' stream prefix.
    this.logWriter?.write(chunk, 'stdout');

    // Buffer partial lines: NDJSON lines from large tool results can span multiple
    // data chunks. Splitting only on '\n' without buffering would emit the tail of
    // a split line as agent:text, showing raw JSON fragments in the UI.
    const combined = this.dataBuffer + chunk;
    const lines = combined.split('\n');
    this.dataBuffer = lines.pop() ?? ''; // last element is incomplete (no trailing \n yet)

    // Parse each NDJSON line and map to a structured AgendoEvent.
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) {
        await this.emitEvent({ type: 'agent:text', text: trimmed });
        continue;
      }

      // Separate try-catch for JSON parsing vs event emission so that a
      // transient emit failure (DB error, etc.) never causes raw JSON to leak
      // into the chat as a system:info message.
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // Line is not JSON — treat as plain text info (shell output, etc.)
        await this.emitEvent({ type: 'system:info', message: trimmed });
        continue;
      }

      try {
        // Generic interactive tool detection: when Claude's own NDJSON output
        // contains a type:'user' block with is_error:true tool_results, it means
        // the CLI tried to handle an interactive tool (AskUserQuestion, ExitPlanMode,
        // or any future tool) natively but failed in pipe mode. We detect this
        // from the raw parsed object BEFORE emitting events, so the suppression
        // check below can immediately catch the resulting agent:tool-end partial.
        //
        // This is fully generic — no hardcoded tool name list needed for the
        // NDJSON path. The is_error flag in Claude's own output is the signal.
        if (parsed.type === 'user') {
          const msg = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
          this.approvalHandler.checkForHumanResponseBlocks(
            msg?.content ?? [],
            this.activeToolUseIds,
          );
        }

        let partials: AgendoEventPayload[];
        try {
          partials = this.adapter.mapJsonToEvents
            ? this.adapter.mapJsonToEvents(parsed)
            : mapClaudeJsonToEvents(parsed, {
                clearDeltaBuffers: () => this.activityTracker.clearDeltaBuffers(),
                appendDelta: (text) => this.activityTracker.appendDelta(text),
                appendThinkingDelta: (text) => this.activityTracker.appendThinkingDelta(text),
                onResultStats: (costUsd, turns) => {
                  void db
                    .update(sessions)
                    .set({
                      ...(costUsd !== null && { totalCostUsd: String(costUsd) }),
                      ...(turns !== null && { totalTurns: turns }),
                    })
                    .where(eq(sessions.id, this.session.id))
                    .catch((err: unknown) => {
                      console.error(
                        `[session-process] cost stats update failed for session ${this.session.id}:`,
                        err,
                      );
                    });
                },
              });
        } catch (mapErr) {
          console.warn(
            `[session-process] mapJsonToEvents error for session ${this.session.id}:`,
            mapErr,
            'line:',
            trimmed.slice(0, 200),
          );
          continue;
        }

        for (const partial of partials) {
          // Suppress tool-start/tool-end for approval-gated tools (ExitPlanMode, …).
          // These appear only as control_request approval cards — not as ToolCard widgets.
          if (
            partial.type === 'agent:tool-start' &&
            ApprovalHandler.APPROVAL_GATED_TOOLS.has(partial.toolName)
          ) {
            this.activeToolUseIds.add(partial.toolUseId); // keep for cleanup
            this.approvalHandler.suppressToolStart(partial.toolUseId);
            continue;
          }
          if (
            partial.type === 'agent:tool-end' &&
            this.approvalHandler.isSuppressedToolEnd(partial.toolUseId, this.activeToolUseIds)
          ) {
            continue;
          }

          // Suppress the error tool-end for any interactive tool: the UI card
          // stays live and pushToolResult routes the human's answer when it arrives.
          if (
            partial.type === 'agent:tool-end' &&
            this.approvalHandler.isPendingHumanResponse(partial.toolUseId)
          ) {
            continue; // suppress — keep in activeToolUseIds until human responds
          }

          const event = await this.emitEvent(partial);

          // Track in-flight tool calls to enable synthetic cleanup on cancel.
          if (event.type === 'agent:tool-start') {
            this.activeToolUseIds.add(event.toolUseId);
          }
          if (event.type === 'agent:tool-end') {
            this.activeToolUseIds.delete(event.toolUseId);
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

          // After the agent finishes a result, transition to awaiting_input.
          // Skip during an interrupt — handleInterrupt() manages the transition
          // based on whether the process survived (warm vs cold resume).
          if (event.type === 'agent:result' && !this.interruptInProgress) {
            await this.transitionTo('awaiting_input');
            this.activityTracker.recordActivity();
          }
        }
      } catch (err) {
        // Event emission failed (transient DB/publish error). Log but don't
        // surface raw JSON to the user — it would appear as a broken UI element.
        console.error(
          `[session-process] Failed to emit event for session ${this.session.id}:`,
          err,
        );
      }
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
      console.warn(`[session-process] Malformed control payload for session ${this.session.id}`);
      return;
    }

    const ctrl = this.makeCtrl();

    if (control.type === 'cancel') {
      await handleCancel(ctrl);
    } else if (control.type === 'interrupt') {
      await handleInterrupt(ctrl);
    } else if (control.type === 'message') {
      let image: ImageContent | undefined;
      if (control.imageRef) {
        try {
          const data = readFileSync(control.imageRef.path).toString('base64');
          image = { mimeType: control.imageRef.mimeType, data };
          // Clean up the temp file (best-effort)
          try {
            unlinkSync(control.imageRef.path);
          } catch {
            /* ignore */
          }
        } catch (err) {
          console.warn(
            `[session-process] Failed to read image file ${control.imageRef.path}:`,
            err,
          );
        }
      }
      await this.pushMessage(control.text, image);
    } else if (control.type === 'redirect') {
      await this.pushMessage(control.newPrompt);
    } else if (control.type === 'tool-approval') {
      const resolver = this.approvalHandler.takeResolver(control.approvalId);
      if (resolver) {
        // ---------------------------------------------------------------
        // ExitPlanMode Option 1: clear context + restart fresh
        // Identical to the CLI TUI behavior: deny the tool, read plan
        // content, kill process, restart with plan as initialPrompt.
        // ---------------------------------------------------------------
        if (control.clearContextRestart) {
          resolver('deny');

          // Read plan content from the stored plan_file_path in DB
          const planContent = await readPlanFromFile(this.session.id);
          const newMode = control.postApprovalMode ?? 'acceptEdits';
          const initialPrompt = planContent
            ? `Implement the following plan:\n\n${planContent}`
            : 'Continue implementing the plan from the previous conversation.';

          // Update DB: clear sessionRef so re-enqueue spawns fresh (not resume),
          // set new initialPrompt and permissionMode.
          await db
            .update(sessions)
            .set({
              sessionRef: null,
              initialPrompt,
              permissionMode: newMode,
            })
            .where(eq(sessions.id, this.session.id));

          await this.emitEvent({
            type: 'system:info',
            message: `Plan approved — clearing context and restarting with ${newMode === 'acceptEdits' ? 'auto-accept edits' : 'manual approval'} mode.`,
          });

          // Kill process → onExit will re-enqueue without resumeRef.
          this.clearContextRestart = true;
          this.terminateKilled = true;
          this.approvalHandler.drain('deny');
          this.managedProcess?.kill('SIGTERM');
          const t = setTimeout(() => {
            this.managedProcess?.kill('SIGKILL');
          }, SIGKILL_DELAY_MS);
          this.sigkillTimers.push(t);
          return;
        }

        // If the user edited the tool input before approving, pass through updatedInput.
        const decision: PermissionDecision =
          control.decision === 'allow' && control.updatedInput
            ? { behavior: 'allow', updatedInput: control.updatedInput }
            : control.decision;
        resolver(decision);

        if (control.decision === 'allow-session') {
          await this.approvalHandler.persistAllowedTool(control.toolName);
        }

        // ExitPlanMode side-effects: apply AFTER resolving the approval so the
        // control_response reaches Claude first (otherwise set_permission_mode
        // control_request times out while Claude waits for the tool response).
        if (control.decision === 'allow') {
          if (control.postApprovalMode) {
            // Small delay to let the allow response reach Claude before sending
            // the set_permission_mode control_request on the same stdin pipe.
            setTimeout(() => {
              handleSetPermissionMode(
                control.postApprovalMode as 'default' | 'acceptEdits',
                this.makeCtrl(),
              ).catch((err: unknown) => {
                console.warn('[session-process] post-approval mode change failed:', err);
              });
            }, 500);
          }
          if (control.postApprovalCompact) {
            // Compact after a delay to let both the allow response and mode change settle.
            setTimeout(
              () => {
                this.pushMessage('/compact').catch((err: unknown) => {
                  console.warn('[session-process] post-approval compact failed:', err);
                });
              },
              control.postApprovalMode ? 2000 : 500,
            );
          }
        }
      }
    } else if (control.type === 'tool-result') {
      if (!['active', 'awaiting_input'].includes(this.status)) {
        console.warn(
          `[session-process] tool-result ignored — session ${this.session.id} is ${this.status}`,
        );
        return;
      }
      await this.approvalHandler.pushToolResult(control.toolUseId, control.content);
    } else if (control.type === 'answer-question') {
      const resolver = this.approvalHandler.takeResolver(control.requestId);
      if (resolver) {
        const questions = this.approvalHandler.takeQuestions(control.requestId);
        resolver({ behavior: 'allow', updatedInput: { questions, answers: control.answers } });
      } else {
        console.warn(
          `[session-process] answer-question for unknown requestId=${control.requestId}`,
        );
      }
    } else if (control.type === 'set-permission-mode') {
      await handleSetPermissionMode(control.mode, ctrl);
    } else if (control.type === 'set-model') {
      await handleSetModel(control.model, ctrl);
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
    // Emit user message and transition to 'active' BEFORE calling sendMessage.
    // This is critical for the Gemini ACP adapter, whose sendMessage() blocks
    // until the full ACP roundtrip completes. If we transitioned after, the
    // thinkingCallback(false) that fires inside sendMessage would see status
    // still as 'awaiting_input' and the transitionTo('awaiting_input') would
    // be a no-op — leaving the session stuck in 'active' forever.
    await this.emitEvent({ type: 'user:message', text, hasImage: !!image });
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
      setCancelKilled: (v) => {
        this.cancelKilled = v;
      },
      setTerminateKilled: (v) => {
        this.terminateKilled = v;
      },
      setModeChangeRestart: (v) => {
        this.modeChangeRestart = v;
      },
      setInterruptInProgress: (v) => {
        this.interruptInProgress = v;
      },
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
    if (status === 'awaiting_input' && this.dataBuffer.trim()) {
      await this.emitEvent({ type: 'agent:text', text: this.dataBuffer.trim() });
      this.dataBuffer = '';
    }

    await db
      .update(sessions)
      .set({ status, lastActiveAt: new Date() })
      .where(eq(sessions.id, this.session.id));
    await this.emitEvent({ type: 'session:state', status });

    if (status === 'awaiting_input') {
      const elapsedSec = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);
      console.log(
        `[session-process] awaiting_input session ${this.session.id} elapsed=${elapsedSec}s — slot released`,
      );
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
    if (this.exitHandled) return;
    this.exitHandled = true;

    const totalSec = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);
    console.log(
      `[session-process] exited session ${this.session.id} code=${exitCode ?? 'null'} status=${this.status} total=${totalSec}s`,
    );
    // Resolve the slot future in case the process exits before ever reaching
    // awaiting_input (e.g. error, cancellation). Safe to call if already resolved.
    this.slotReleaseFuture.resolve();

    this.activityTracker.stopAllTimers();
    // Clear any pending SIGKILL escalation timers — the process has already exited.
    for (const t of this.sigkillTimers) {
      clearTimeout(t);
    }
    this.sigkillTimers = [];
    // Drain any approval promises so blocked adapters unblock immediately.
    this.approvalHandler.drain('deny');
    // Stop team inbox monitoring.
    this.teamManager.stop();
    // Unsubscribe from the control channel to release the pg pool connection.
    // Null it out immediately to prevent any subsequent re-entry from releasing twice.
    this.unsubscribeControl?.();
    this.unsubscribeControl = null;

    // Determine final session status based on exit code.
    // cancelKilled = user pressed Stop → already ended by the cancel route, no error.
    // Clean exit (0) = agent finished normally → idle (resumable).
    // terminateKilled = graceful worker shutdown → idle (auto-resumable on next message).
    // interruptKilled / idleTimeoutKilled → idle (resumable).
    // Anything else → ended (crash / unsupported command).
    if (this.status === 'active' || this.status === 'awaiting_input') {
      if (this.cancelKilled) {
        // Cancel route may have already set status='ended' in DB, but if the process
        // died before the cancel route could update, status may still be 'active'.
        // Explicitly transition to 'ended' to cover both cases.
        await this.transitionTo('ended');
        spawnSync('tmux', ['kill-session', '-t', `shell-${this.session.id}`], { stdio: 'ignore' });
      } else if (
        exitCode === 0 ||
        this.activityTracker.idleTimeoutKilled ||
        this.activityTracker.interruptKilled ||
        this.terminateKilled
      ) {
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

    if (this.status === 'ended') {
      await db
        .update(sessions)
        .set({ endedAt: new Date() })
        .where(eq(sessions.id, this.session.id));
    }

    // Mode-change restart: re-enqueue immediately so the session cold-resumes
    // with the updated permissionMode (already written to DB by the PATCH endpoint).
    // The session status is now 'idle', so the next session-runner job can claim it.
    if (this.modeChangeRestart && this.sessionRef) {
      enqueueSession({ sessionId: this.session.id, resumeRef: this.sessionRef }).catch(
        (err: unknown) => {
          console.error(
            `[session-process] Failed to re-enqueue session ${this.session.id} after mode change:`,
            err,
          );
        },
      );
    }

    // Clear-context restart (ExitPlanMode option 1): re-enqueue WITHOUT resumeRef
    // so the session-runner calls adapter.spawn() (not resume) → fresh conversation.
    // DB was already updated (sessionRef=null, new initialPrompt, new permissionMode)
    // in the tool-approval handler before killing the process.
    if (this.clearContextRestart) {
      enqueueSession({ sessionId: this.session.id }).catch((err: unknown) => {
        console.error(
          `[session-process] Failed to re-enqueue session ${this.session.id} after clear-context restart:`,
          err,
        );
      });
    }

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
    // Set flag BEFORE sending SIGTERM so onExit transitions to 'idle' (resumable)
    // instead of 'ended'. This allows cold-resume after a graceful worker restart.
    this.terminateKilled = true;
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
    this.terminateKilled = true;
  }
}
