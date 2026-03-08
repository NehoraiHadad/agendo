import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';
import { recordInterruptionEvent, type InFlightTool } from '@/lib/worker/interruption-marker';
import type { AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';

const log = createLogger('session-exit-logic');

// ---------------------------------------------------------------------------
// ExitReason + ExitContext
// ---------------------------------------------------------------------------

export type ExitReason =
  | 'none'
  | 'cancel'
  | 'terminate'
  | 'mode-change-restart'
  | 'clear-context-restart'
  | 'idle-timeout'
  | 'interrupt';

/**
 * Tracks why and how a session process is exiting. Computed getters derive
 * the boolean flags that `determineExitStatus` and `handleReEnqueue` need.
 */
export class ExitContext {
  reason: ExitReason = 'none';
  exitHandled = false;
  interruptInProgress = false;
  clearContextRestartNewSessionId: string | null = null;

  get cancelKilled(): boolean {
    return this.reason === 'cancel';
  }

  get terminateKilled(): boolean {
    return (
      this.reason === 'terminate' ||
      this.reason === 'mode-change-restart' ||
      this.reason === 'clear-context-restart'
    );
  }

  get modeChangeRestart(): boolean {
    return this.reason === 'mode-change-restart';
  }

  get clearContextRestart(): boolean {
    return this.reason === 'clear-context-restart';
  }
}

// ---------------------------------------------------------------------------
// Dependency interfaces (for testability)
// ---------------------------------------------------------------------------

export interface CleanupDeps {
  activityTracker: { stopAllTimers(): void };
  sigkillTimers: ReturnType<typeof setTimeout>[];
  approvalHandler: { drain(decision: 'deny'): void };
  teamManager: { stop(): void };
  policyFilePath: string | null;
  unsubscribeControl: (() => void) | null;
}

export interface ExitStatusDeps {
  sessionId: string;
  taskId: string | null;
  agentId: string;
  currentStatus: SessionStatus;
  activeToolInfo: Map<string, InFlightTool>;
  emitEvent(payload: AgendoEventPayload): Promise<unknown>;
  transitionTo(status: SessionStatus): Promise<void>;
}

// ---------------------------------------------------------------------------
// cleanupResources
// ---------------------------------------------------------------------------

/**
 * Release all resources held by the session: stop timers, drain approvals,
 * stop team monitoring, clean up temp files, and unsubscribe from PG NOTIFY.
 */
export function cleanupResources(deps: CleanupDeps): void {
  deps.activityTracker.stopAllTimers();

  // Clear any pending SIGKILL escalation timers — the process has already exited.
  for (const t of deps.sigkillTimers) {
    clearTimeout(t);
  }
  deps.sigkillTimers.length = 0;

  // Drain any approval promises so blocked adapters unblock immediately.
  deps.approvalHandler.drain('deny');

  // Stop team inbox monitoring.
  deps.teamManager.stop();

  // Clean up temp Gemini policy file (best-effort).
  if (deps.policyFilePath) {
    try {
      unlinkSync(deps.policyFilePath);
    } catch {
      // File may already be gone.
    }
    deps.policyFilePath = null;
  }

  // Unsubscribe from the control channel to release the pg pool connection.
  // Null it out immediately to prevent any subsequent re-entry from releasing twice.
  deps.unsubscribeControl?.();
  deps.unsubscribeControl = null;
}

// ---------------------------------------------------------------------------
// determineExitStatus
// ---------------------------------------------------------------------------

/**
 * Map exit code and session flags to the final session status, emit
 * interruption notes, and persist endedAt when appropriate.
 */
export async function determineExitStatus(
  ctx: ExitContext,
  exitCode: number | null,
  wasInterruptedMidTurn: boolean,
  deps: ExitStatusDeps,
): Promise<void> {
  // When a session is interrupted mid-turn by a worker restart (terminateKilled && active),
  // record an interruption note in the task event log.
  if (wasInterruptedMidTurn && deps.taskId) {
    const inflight = [...deps.activeToolInfo.values()];
    try {
      await deps.emitEvent({
        type: 'system:info',
        message:
          inflight.length > 0
            ? `Session interrupted mid-turn. In-flight tool(s): ${inflight.map((t) => t.toolName).join(', ')}.`
            : 'Session interrupted mid-turn (worker restart).',
      });
    } catch {
      // Best-effort: log writer may already be closing
    }
    try {
      await recordInterruptionEvent(deps.taskId, inflight, deps.agentId);
    } catch (err) {
      log.warn({ err, sessionId: deps.sessionId }, 'Failed to record interruption event');
    }
  }

  // Determine final session status based on exit code.
  // cancelKilled = user pressed Stop → already ended by the cancel route, no error.
  // Clean exit (0) = agent finished normally → idle (resumable).
  // terminateKilled = graceful worker shutdown → idle (auto-resumable on next message).
  // interrupt / idle-timeout → idle (resumable).
  // Anything else → ended (crash / unsupported command).
  if (deps.currentStatus === 'active' || deps.currentStatus === 'awaiting_input') {
    if (ctx.cancelKilled) {
      await deps.transitionTo('ended');
      spawnSync('tmux', ['kill-session', '-t', `shell-${deps.sessionId}`], { stdio: 'ignore' });
    } else if (
      exitCode === 0 ||
      ctx.reason === 'idle-timeout' ||
      ctx.reason === 'interrupt' ||
      ctx.terminateKilled
    ) {
      await deps.transitionTo('idle');
    } else {
      await deps.emitEvent({
        type: 'system:error',
        message:
          `Session ended unexpectedly (exit code ${exitCode ?? 'null'}). ` +
          `This may be caused by a configuration error, an unsupported command, or an agent CLI crash.`,
      });
      await deps.transitionTo('ended');
      // Kill the companion terminal tmux session — session is no longer resumable.
      spawnSync('tmux', ['kill-session', '-t', `shell-${deps.sessionId}`], { stdio: 'ignore' });
    }
  }

  // Persist endedAt timestamp when the session is ended.
  // Note: We check the actual DB status since transitionTo may have changed it.
  // In the extracted version, the caller is responsible for checking final status.
  // We use a simple heuristic: if we just called transitionTo('ended'), persist endedAt.
  if (
    ctx.cancelKilled ||
    ((deps.currentStatus === 'active' || deps.currentStatus === 'awaiting_input') &&
      !ctx.terminateKilled &&
      exitCode !== 0 &&
      ctx.reason !== 'idle-timeout' &&
      ctx.reason !== 'interrupt')
  ) {
    await db.update(sessions).set({ endedAt: new Date() }).where(eq(sessions.id, deps.sessionId));
  }
}
