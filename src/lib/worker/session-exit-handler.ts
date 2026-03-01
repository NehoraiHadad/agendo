/**
 * Exit state machine extracted from SessionProcess.
 *
 * Determines the final session status based on exit code and kill flags,
 * cleans up resources, and re-enqueues the session for restart when needed
 * (mode-change restart, clear-context restart).
 */

import { spawnSync } from 'node:child_process';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { AgendoEvent, AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';
import { enqueueSession } from '@/lib/worker/queue';
import type { FileLogWriter } from '@/lib/worker/log-writer';
import type { ApprovalHandler } from '@/lib/worker/approval-handler';
import type { ActivityTracker } from '@/lib/worker/activity-tracker';
import type { SessionTeamManager } from '@/lib/worker/session-team-manager';
import type { Future } from '@/lib/utils/future';

export interface SessionExitCtx {
  sessionId: string;
  status: SessionStatus;
  sessionStartTime: number;

  // Kill flags (read-only — set before onExit runs)
  cancelKilled: boolean;
  terminateKilled: boolean;
  modeChangeRestart: boolean;
  clearContextRestart: boolean;
  sessionRef: string | null;

  // Subsystems
  activityTracker: ActivityTracker;
  approvalHandler: ApprovalHandler;
  teamManager: SessionTeamManager;
  logWriter: FileLogWriter | null;

  // Timers
  sigkillTimers: ReturnType<typeof setTimeout>[];

  // Futures
  slotReleaseFuture: Future<void>;
  exitFuture: Future<number | null>;

  // Control channel teardown
  unsubscribeControl: (() => void) | null;
  clearUnsubscribeControl(): void;

  // Callbacks
  emitEvent(payload: AgendoEventPayload): Promise<AgendoEvent>;
  transitionTo(status: SessionStatus): Promise<void>;
  clearLogWriter(): void;
}

/**
 * Handle the session process exit: determine final status, clean up resources,
 * and re-enqueue if needed. Returns the exit code for the exitFuture.
 */
export async function handleSessionExit(
  exitCode: number | null,
  ctx: SessionExitCtx,
): Promise<void> {
  const totalSec = ((Date.now() - ctx.sessionStartTime) / 1000).toFixed(1);
  console.log(
    `[session-process] exited session ${ctx.sessionId} code=${exitCode ?? 'null'} status=${ctx.status} total=${totalSec}s`,
  );
  // Resolve the slot future in case the process exits before ever reaching
  // awaiting_input (e.g. error, cancellation). Safe to call if already resolved.
  ctx.slotReleaseFuture.resolve();

  ctx.activityTracker.stopAllTimers();
  // Clear any pending SIGKILL escalation timers — the process has already exited.
  for (const t of ctx.sigkillTimers) {
    clearTimeout(t);
  }
  ctx.sigkillTimers.length = 0;
  // Drain any approval promises so blocked adapters unblock immediately.
  ctx.approvalHandler.drain('deny');
  // Stop team inbox monitoring.
  ctx.teamManager.stop();
  // Unsubscribe from the control channel to release the pg pool connection.
  // Null it out immediately to prevent any subsequent re-entry from releasing twice.
  ctx.unsubscribeControl?.();
  ctx.clearUnsubscribeControl();

  // Determine final session status based on exit code.
  // cancelKilled = user pressed Stop → already ended by the cancel route, no error.
  // Clean exit (0) = agent finished normally → idle (resumable).
  // terminateKilled = graceful worker shutdown → idle (auto-resumable on next message).
  // interruptKilled / idleTimeoutKilled → idle (resumable).
  // Anything else → ended (crash / unsupported command).
  if (ctx.status === 'active' || ctx.status === 'awaiting_input') {
    if (ctx.cancelKilled) {
      // Cancel route may have already set status='ended' in DB, but if the process
      // died before the cancel route could update, status may still be 'active'.
      // Explicitly transition to 'ended' to cover both cases.
      await ctx.transitionTo('ended');
      spawnSync('tmux', ['kill-session', '-t', `shell-${ctx.sessionId}`], { stdio: 'ignore' });
    } else if (
      exitCode === 0 ||
      ctx.activityTracker.idleTimeoutKilled ||
      ctx.activityTracker.interruptKilled ||
      ctx.terminateKilled
    ) {
      await ctx.transitionTo('idle');
    } else {
      await ctx.emitEvent({
        type: 'system:error',
        message:
          `Session ended unexpectedly (exit code ${exitCode ?? 'null'}). ` +
          `This may be caused by an unsupported slash command (/mcp, /permissions) or a Claude CLI crash.`,
      });
      await ctx.transitionTo('ended');
      // Kill the companion terminal tmux session — session is no longer resumable.
      spawnSync('tmux', ['kill-session', '-t', `shell-${ctx.sessionId}`], { stdio: 'ignore' });
    }
  }

  if (ctx.status === 'ended') {
    await db.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, ctx.sessionId));
  }

  // Mode-change restart: re-enqueue immediately so the session cold-resumes
  // with the updated permissionMode (already written to DB by the PATCH endpoint).
  // The session status is now 'idle', so the next session-runner job can claim it.
  if (ctx.modeChangeRestart && ctx.sessionRef) {
    enqueueSession({ sessionId: ctx.sessionId, resumeRef: ctx.sessionRef }).catch(
      (err: unknown) => {
        console.error(
          `[session-process] Failed to re-enqueue session ${ctx.sessionId} after mode change:`,
          err,
        );
      },
    );
  }

  // Clear-context restart (ExitPlanMode option 1): re-enqueue WITHOUT resumeRef
  // so the session-runner calls adapter.spawn() (not resume) → fresh conversation.
  // DB was already updated (sessionRef=null, new initialPrompt, new permissionMode)
  // in the tool-approval handler before killing the process.
  if (ctx.clearContextRestart) {
    enqueueSession({ sessionId: ctx.sessionId }).catch((err: unknown) => {
      console.error(
        `[session-process] Failed to re-enqueue session ${ctx.sessionId} after clear-context restart:`,
        err,
      );
    });
  }

  if (ctx.logWriter) {
    await ctx.logWriter.close();
    ctx.clearLogWriter();
  }

  ctx.exitFuture.resolve(exitCode);
}
