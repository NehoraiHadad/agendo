/**
 * Control handler functions extracted from SessionProcess.
 *
 * Each function receives a SessionControlCtx that provides access to the
 * session state and callbacks needed to perform the action. This keeps
 * session-process.ts focused on lifecycle orchestration.
 */
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import type { AttachmentRef } from '@/lib/attachments';

const log = createLogger('session-control');
import type {
  AgendoEvent,
  AgendoEventPayload,
  AgendoControl,
  SessionStatus,
} from '@/lib/realtime/events';
import type { Session } from '@/lib/types';
import type { AgentAdapter, ManagedProcess, PermissionDecision } from '@/lib/worker/adapters/types';
import type { ApprovalHandler } from '@/lib/worker/approval-handler';
import type { ActivityTracker } from '@/lib/worker/activity-tracker';
import { SIGKILL_DELAY_MS } from '@/lib/worker/constants';
import { savePlanFromSession } from '@/lib/worker/session-plan-utils';
import { enqueueSession } from '@/lib/worker/queue';
import type { ExitContext } from '@/lib/worker/session-exit-logic';
import { getErrorMessage } from '@/lib/utils/error-utils';

/** Human-readable labels for permission modes. */
export const MODE_LABELS: Record<string, string> = {
  plan: 'Plan — agent presents a plan before executing',
  default: 'Approve — each tool requires your approval',
  acceptEdits: 'Edit Only — file edits auto-approved, bash needs approval',
  bypassPermissions: 'Auto — all tools auto-approved',
  dontAsk: 'Auto — all tools auto-approved',
};

export interface SessionControlCtx {
  session: Session;
  adapter: AgentAdapter;
  managedProcess: ManagedProcess | null;
  sigkillTimers: ReturnType<typeof setTimeout>[];
  approvalHandler: ApprovalHandler;
  activityTracker: ActivityTracker;
  activeToolUseIds: Set<string>;
  emitEvent(payload: AgendoEventPayload): Promise<AgendoEvent>;
  transitionTo(status: SessionStatus): Promise<void>;
  exitContext: ExitContext;
  pushMessage(
    text: string,
    opts?: {
      attachments?: AttachmentRef[];
      priority?: import('@/lib/realtime/events').MessagePriority;
      clientId?: string;
    },
  ): Promise<void>;
  /** Build a fresh SessionControlCtx — needed when scheduling a delayed handleSetPermissionMode. */
  makeCtrl(): SessionControlCtx;
}

/**
 * Handle a cancel control: emit cancellation events, drain approvals, and
 * interrupt the adapter process.
 */
export async function handleCancel(ctx: SessionControlCtx): Promise<void> {
  // Set flag BEFORE sending the interrupt so onExit doesn't emit "Session ended
  // unexpectedly" — a user-initiated cancel is not a crash.
  ctx.exitContext.reason = 'cancel';
  await ctx.emitEvent({ type: 'system:info', message: 'Cancellation requested' });
  // Emit synthetic tool-end for every in-flight tool call to prevent forever-spinners.
  for (const toolUseId of ctx.activeToolUseIds) {
    await ctx.emitEvent({ type: 'agent:tool-end', toolUseId, content: '[Interrupted by user]' });
  }
  ctx.activeToolUseIds.clear();
  ctx.approvalHandler.clearSuppressed();
  // Drain pending tool approvals so any adapter blocked on handleApprovalRequest unblocks.
  ctx.approvalHandler.drain('deny');
  await ctx.adapter.interrupt();
  // Send SIGTERM immediately to force the process to stop. adapter.interrupt()
  // is a polite request (e.g. stdin command) that the agent can ignore if it's
  // mid-reasoning or tool execution. SIGTERM ensures timely shutdown.
  ctx.managedProcess?.kill('SIGTERM');
  // Escalate to SIGKILL after grace period in case SIGTERM is also ignored.
  const t = setTimeout(() => {
    ctx.managedProcess?.kill('SIGKILL');
  }, SIGKILL_DELAY_MS);
  ctx.sigkillTimers.push(t);
}

/**
 * Handle an interrupt control (soft stop): ask the adapter to stop gracefully.
 * If the process survives, the session stays warm for immediate follow-up.
 */
export async function handleInterrupt(ctx: SessionControlCtx): Promise<void> {
  ctx.exitContext.interruptInProgress = true;
  // Pre-set reason so that if the process dies during the interrupt,
  // onExit transitions to 'idle' (resumable) instead of 'ended'.
  ctx.activityTracker.interruptKilled = true;

  await ctx.emitEvent({ type: 'system:info', message: 'Stopping...' });
  for (const toolUseId of ctx.activeToolUseIds) {
    await ctx.emitEvent({ type: 'agent:tool-end', toolUseId, content: '[Interrupted]' });
  }
  ctx.activeToolUseIds.clear();
  ctx.approvalHandler.clearSuppressed();

  // Ask the adapter to send an interrupt signal. For Claude this writes a
  // control_request{subtype:'interrupt'} to stdin and waits up to 3s for a
  // 'result' event. If Claude handles it gracefully the process stays alive;
  // if it dies or times out, adapter.isAlive() will be false afterwards.
  await ctx.adapter.interrupt();

  ctx.exitContext.interruptInProgress = false;

  if (ctx.adapter.isAlive()) {
    // Claude stopped the current action but is still running — warm session,
    // user can send another message immediately without a cold resume.
    ctx.activityTracker.interruptKilled = false; // process survived, clear the pre-set flag
    await ctx.transitionTo('awaiting_input');
    ctx.activityTracker.recordActivity();
  }
  // else: process died during interrupt — interruptKilled=true so onExit will
  // transition to 'idle' (not 'ended'), keeping the session cold-resumable.
}

/**
 * Handle a set-permission-mode control: update in-memory session state and DB,
 * emit a system:info event visible in the chat. If the adapter supports
 * in-place mode switching, use it (no restart). Otherwise fall back to
 * killing and cold-resuming with the new flags.
 */
export async function handleSetPermissionMode(
  mode: 'default' | 'bypassPermissions' | 'acceptEdits' | 'plan' | 'dontAsk',
  ctx: SessionControlCtx,
): Promise<void> {
  ctx.session.permissionMode = mode;
  const label = MODE_LABELS[mode] ?? mode;

  // Try in-place mode change via control_request (no process restart).
  if (ctx.adapter.setPermissionMode) {
    try {
      const success = await ctx.adapter.setPermissionMode(mode);
      if (success) {
        await db
          .update(sessions)
          .set({ permissionMode: mode })
          .where(eq(sessions.id, ctx.session.id));
        await ctx.emitEvent({ type: 'system:info', message: `Permission mode \u2192 ${label}.` });
        return;
      }
    } catch (err) {
      log.warn(
        { err, sessionId: ctx.session.id },
        'In-place setPermissionMode failed, falling back to restart',
      );
    }
  }

  // Fallback: kill and restart with new mode.
  await ctx.emitEvent({
    type: 'system:info',
    message: `Permission mode \u2192 ${label}. Session will restart automatically.`,
  });
  ctx.exitContext.reason = 'mode-change-restart';
  ctx.approvalHandler.drain('deny');
  ctx.managedProcess?.kill('SIGTERM');
  const t = setTimeout(() => {
    ctx.managedProcess?.kill('SIGKILL');
  }, SIGKILL_DELAY_MS);
  ctx.sigkillTimers.push(t);
}

/** Handle a set-model control: switch the running session's model. */
export async function handleSetModel(model: string, ctx: SessionControlCtx): Promise<void> {
  if (!ctx.adapter.setModel) {
    await ctx.emitEvent({
      type: 'system:error',
      message: 'Model switching is not supported by this agent.',
    });
    return;
  }

  try {
    const success = await ctx.adapter.setModel(model);
    if (success) {
      await db.update(sessions).set({ model }).where(eq(sessions.id, ctx.session.id));
      // Emit system:info — the info panel and detail header parse the model from
      // this message. We intentionally do NOT emit a session:init here because that
      // would clobber the real init event's mcpServers, slashCommands, and sessionRef
      // with empty values.
      await ctx.emitEvent({ type: 'system:info', message: `Model switched to "${model}".` });
    } else {
      await ctx.emitEvent({
        type: 'system:error',
        message: `Failed to switch model to "${model}" — CLI did not respond.`,
      });
    }
  } catch (err) {
    await ctx.emitEvent({
      type: 'system:error',
      message: `Failed to switch model: ${getErrorMessage(err)}`,
    });
  }
}

/**
 * Handle a message control: forward optional attachments and push the
 * message to the running agent.
 */
export async function handleMessage(
  control: Extract<AgendoControl, { type: 'message' }>,
  ctx: SessionControlCtx,
): Promise<void> {
  await ctx.pushMessage(control.text, {
    attachments: control.attachments,
    priority: control.priority,
    clientId: control.clientId,
  });
}

/**
 * Handle a tool-approval control: resolve the pending approval promise,
 * apply ExitPlanMode side-effects (clear-context restart, post-approval
 * mode change, post-approval compact), and persist session-scoped
 * tool allowlists.
 */
export async function handleToolApproval(
  control: Extract<AgendoControl, { type: 'tool-approval' }>,
  ctx: SessionControlCtx,
): Promise<void> {
  const resolver = ctx.approvalHandler.takeResolver(control.approvalId);
  if (!resolver) return;

  // -------------------------------------------------------------------
  // ExitPlanMode Option 1: clear context + restart fresh
  // Identical to the CLI TUI behavior: deny the tool, read plan
  // content, kill process, restart with plan as initialPrompt.
  // -------------------------------------------------------------------
  if (control.clearContextRestart) {
    resolver('deny');

    // The API route already created the new child session and passed its
    // ID here via newSessionIdForWorker. Store it so onExit can enqueue it.
    const newMode = control.postApprovalMode ?? 'acceptEdits';
    ctx.exitContext.clearContextRestartNewSessionId = control.newSessionIdForWorker ?? null;

    await ctx.emitEvent({
      type: 'system:info',
      message: `Plan approved — restarting fresh with ${newMode === 'acceptEdits' ? 'auto-accept edits' : 'manual approval'} mode.`,
    });

    // Kill process → onExit will enqueue the new child session.
    ctx.exitContext.reason = 'clear-context-restart';
    ctx.approvalHandler.drain('deny');
    ctx.managedProcess?.kill('SIGTERM');
    const t = setTimeout(() => {
      ctx.managedProcess?.kill('SIGKILL');
    }, SIGKILL_DELAY_MS);
    ctx.sigkillTimers.push(t);
    return;
  }

  // If the user edited the tool input before approving, or requested session-scoped
  // command memory (Codex), pass through as a structured PermissionDecision.
  const decision: PermissionDecision =
    control.decision === 'allow' && (control.updatedInput || control.rememberForSession)
      ? {
          behavior: 'allow',
          ...(control.updatedInput ? { updatedInput: control.updatedInput } : {}),
          ...(control.rememberForSession ? { rememberForSession: true } : {}),
        }
      : control.decision;
  resolver(decision);

  if (control.decision === 'allow-session') {
    await ctx.approvalHandler.persistAllowedTool(control.toolName);
  }

  // ExitPlanMode side-effects: apply AFTER resolving the approval so the
  // control_response reaches Claude first (otherwise set_permission_mode
  // control_request times out while Claude waits for the tool response).
  if (control.decision === 'allow') {
    // Auto-save plan to plans table when ExitPlanMode is approved
    const isExitPlanMode =
      control.toolName === 'ExitPlanMode' || control.toolName === 'exit_plan_mode';
    if (isExitPlanMode) {
      savePlanFromSession(ctx.session).catch((err: unknown) => {
        log.warn({ err }, 'Failed to auto-save plan');
      });
    }

    if (control.postApprovalMode) {
      // Small delay to let the allow response reach Claude before sending
      // the set_permission_mode control_request on the same stdin pipe.
      setTimeout(() => {
        handleSetPermissionMode(
          control.postApprovalMode as 'default' | 'acceptEdits' | 'bypassPermissions',
          ctx.makeCtrl(),
        ).catch((err: unknown) => {
          log.warn({ err }, 'post-approval mode change failed');
        });
      }, 500);
    }
    if (control.postApprovalCompact) {
      // Compact after a delay to let both the allow response and mode change settle.
      setTimeout(
        () => {
          ctx.pushMessage('/compact').catch((err: unknown) => {
            log.warn({ err }, 'post-approval compact failed');
          });
        },
        control.postApprovalMode ? 2000 : 500,
      );
    }
  }
}

/**
 * Handle a cancel-queued control: attempt to remove a queued message from the
 * adapter's in-memory queue before the SDK consumes it.
 */
export async function handleCancelQueued(
  control: Extract<AgendoControl, { type: 'cancel-queued' }>,
  ctx: SessionControlCtx,
): Promise<void> {
  const removed = ctx.adapter.cancelQueuedMessage?.(control.clientId) ?? false;
  if (removed) {
    await ctx.emitEvent({ type: 'user:message-cancelled', clientId: control.clientId });
  }
  // If not removed (already consumed or adapter doesn't support it), do nothing —
  // the frontend will see the message appear in the chat as usual.
}

/**
 * Handle a redirect control: push the new prompt as a message to the agent.
 */
export async function handleRedirect(
  control: Extract<AgendoControl, { type: 'redirect' }>,
  ctx: SessionControlCtx,
): Promise<void> {
  await ctx.pushMessage(control.newPrompt);
}

/**
 * Handle a tool-result control: forward a tool_result to the agent if the
 * session is in a valid state.
 */
export async function handleToolResult(
  control: Extract<AgendoControl, { type: 'tool-result' }>,
  ctx: SessionControlCtx,
  status: string,
): Promise<void> {
  if (!['active', 'awaiting_input'].includes(status)) {
    log.warn({ sessionId: ctx.session.id, status }, 'tool-result ignored — wrong session status');
    return;
  }
  await ctx.approvalHandler.pushToolResult(control.toolUseId, control.content);
}

/**
 * Handle a steer control: inject a steering message into the current turn.
 */
export async function handleSteer(
  control: Extract<AgendoControl, { type: 'steer' }>,
  ctx: SessionControlCtx,
): Promise<void> {
  await ctx.adapter.steer?.(control.message);
}

/**
 * Handle a rollback control: undo the last N turns in the agent thread.
 */
export async function handleRollback(
  control: Extract<AgendoControl, { type: 'rollback' }>,
  ctx: SessionControlCtx,
): Promise<void> {
  await ctx.adapter.rollback?.(control.numTurns ?? 1);
}

// ---------------------------------------------------------------------------
// Post-exit re-enqueue logic
// ---------------------------------------------------------------------------

export interface ReEnqueueContext {
  sessionId: string;
  /** Current session ref (runtime, may differ from DB). */
  sessionRef: string | null;
  /** Persisted session ref from DB (fallback). */
  dbSessionRef: string | null;
  exitContext: ExitContext;
  /**
   * True when Claude failed with "No conversation found" — the session has a
   * sessionRef but the JSONL contains no actual history (only queue-operations).
   * Triggers a fresh spawn instead of a resume attempt, using initialPrompt.
   */
  conversationNotFound?: boolean;
  /** Original first-message prompt for fresh-start fallback. */
  initialPrompt?: string | null;
}

/**
 * Maximum number of consecutive auto-resume attempts before giving up.
 * Persisted in the DB (sessions.autoResumeCount) to survive worker restarts.
 * Resets to 0 when a session completes a successful turn (awaiting_input).
 */
const MAX_AUTO_RESUME_ATTEMPTS = 3;

/**
 * Atomically increment the session's autoResumeCount in the DB and return the
 * new value. Returns null if the session row was not found (shouldn't happen).
 */
async function incrementAutoResumeCount(sessionId: string): Promise<number | null> {
  const [row] = await db
    .update(sessions)
    .set({ autoResumeCount: sql`auto_resume_count + 1` })
    .where(eq(sessions.id, sessionId))
    .returning({ autoResumeCount: sessions.autoResumeCount });
  return row?.autoResumeCount ?? null;
}

/**
 * Determine whether and how to re-enqueue a session after exit.
 * Fire-and-forget: logs errors but does not throw.
 */
export function handleReEnqueue(ctx: ReEnqueueContext, wasInterruptedMidTurn: boolean): void {
  // "No conversation found" fallback: the sessionRef existed in the DB but
  // Claude's JSONL had no actual conversation history (only queue-operations).
  // The sessionRef was already cleared by session-process before calling here.
  // Re-enqueue as a completely fresh spawn using the original initialPrompt so
  // the user's intent is preserved without any "please continue" framing.
  if (ctx.conversationNotFound) {
    if (ctx.initialPrompt) {
      (async () => {
        try {
          const count = await incrementAutoResumeCount(ctx.sessionId);
          if (count !== null && count > MAX_AUTO_RESUME_ATTEMPTS) {
            log.warn(
              { sessionId: ctx.sessionId, attempts: count },
              'Session hit auto-resume limit after "No conversation found", leaving idle',
            );
            return;
          }
          await enqueueSession({
            sessionId: ctx.sessionId,
            resumePrompt: ctx.initialPrompt ?? '',
          });
          log.info(
            { sessionId: ctx.sessionId, attempt: count },
            'Session auto-restarted fresh: "No conversation found" with empty JSONL',
          );
        } catch (err) {
          log.error(
            { err, sessionId: ctx.sessionId },
            'Failed to re-enqueue session after conversation-not-found fallback',
          );
        }
      })();
    } else {
      log.info(
        { sessionId: ctx.sessionId },
        'Session went idle after "No conversation found": no initialPrompt to restart with',
      );
    }
    // Skip all other re-enqueue paths — this case supersedes them.
    return;
  }

  // Mode-change restart: re-enqueue immediately so the session cold-resumes
  // with the updated permissionMode (already written to DB by the PATCH endpoint).
  // The session status is now 'idle', so the next session-runner job can claim it.
  // No counter check — this is a deliberate user-initiated action, not crash recovery.
  if (ctx.exitContext.modeChangeRestart && ctx.sessionRef) {
    enqueueSession({ sessionId: ctx.sessionId, resumeRef: ctx.sessionRef }).catch(
      (err: unknown) => {
        log.error(
          { err, sessionId: ctx.sessionId },
          'Failed to re-enqueue session after mode change',
        );
      },
    );
  }

  // Clear-context restart (ExitPlanMode "Restart fresh"): enqueue the new child
  // session that was created by the API route (Direction B — new session record).
  // No counter check — this is a deliberate user-initiated action, not crash recovery.
  if (ctx.exitContext.clearContextRestart) {
    const targetSessionId = ctx.exitContext.clearContextRestartNewSessionId ?? ctx.sessionId;
    enqueueSession({ sessionId: targetSessionId }).catch((err: unknown) => {
      log.error(
        { err, sessionId: targetSessionId },
        'Failed to enqueue new session after clear-context restart',
      );
    });
  }

  // Mid-turn interruption auto-resume for UNEXPECTED crashes only.
  // Covers: agendo restart (MCP drop), CLI crash, non-zero exit with no known reason.
  //
  // Planned worker restarts (terminateKilled) are NOT handled here — the
  // zombie-reconciler on the next cold start handles those. Running both
  // causes a double-enqueue race: handleReEnqueue fires during shutdown,
  // zombie-reconciler fires on startup, and the session gets two resume
  // prompts — the first without the "restart succeeded" context.
  const resumeRef = ctx.sessionRef ?? ctx.dbSessionRef ?? null;
  if (
    wasInterruptedMidTurn &&
    resumeRef &&
    !ctx.exitContext.cancelKilled &&
    !ctx.exitContext.clearContextRestart &&
    !ctx.exitContext.modeChangeRestart &&
    !ctx.exitContext.terminateKilled
  ) {
    (async () => {
      try {
        const count = await incrementAutoResumeCount(ctx.sessionId);
        if (count !== null && count > MAX_AUTO_RESUME_ATTEMPTS) {
          log.warn(
            { sessionId: ctx.sessionId, attempts: count, max: MAX_AUTO_RESUME_ATTEMPTS },
            'Session hit auto-resume limit, leaving idle instead of re-enqueueing',
          );
          return;
        }
        const resumePrompt =
          'The session was interrupted by an infrastructure restart (e.g. the agendo server restarted). Please continue where you left off.';
        await enqueueSession({
          sessionId: ctx.sessionId,
          resumeRef,
          resumePrompt,
          skipResumeContext: true,
        });
        log.info(
          {
            sessionId: ctx.sessionId,
            attempt: count,
          },
          'Session auto-resumed after unexpected interruption',
        );
      } catch (err) {
        log.error(
          { err, sessionId: ctx.sessionId },
          'Failed to re-enqueue session after mid-turn interruption',
        );
      }
    })();
  }
}
