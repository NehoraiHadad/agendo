/**
 * Control handler functions extracted from SessionProcess.
 *
 * Each function receives a SessionControlCtx that provides access to the
 * session state and callbacks needed to perform the action. This keeps
 * session-process.ts focused on lifecycle orchestration.
 */

import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { AgendoEvent, AgendoEventPayload, SessionStatus } from '@/lib/realtime/events';
import type { Session } from '@/lib/types';
import type { AgentAdapter, ManagedProcess } from '@/lib/worker/adapters/types';
import type { ApprovalHandler } from '@/lib/worker/approval-handler';
import type { ActivityTracker } from '@/lib/worker/activity-tracker';
import { SIGKILL_DELAY_MS } from '@/lib/worker/constants';

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
  setCancelKilled(v: boolean): void;
  setTerminateKilled(v: boolean): void;
  setModeChangeRestart(v: boolean): void;
  setInterruptInProgress(v: boolean): void;
}

/**
 * Handle a cancel control: emit cancellation events, drain approvals, and
 * interrupt the adapter process.
 */
export async function handleCancel(ctx: SessionControlCtx): Promise<void> {
  // Set flag BEFORE sending the interrupt so onExit doesn't emit "Session ended
  // unexpectedly" — a user-initiated cancel is not a crash.
  ctx.setCancelKilled(true);
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
  // Allow graceful shutdown; escalate to SIGKILL after grace period.
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
  ctx.setInterruptInProgress(true);
  // Pre-set interruptKilled so that if the process dies during the interrupt,
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

  ctx.setInterruptInProgress(false);

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
      console.warn(
        `[session-control] In-place setPermissionMode failed for session ${ctx.session.id}, falling back to restart:`,
        err,
      );
    }
  }

  // Fallback: kill and restart with new mode.
  await ctx.emitEvent({
    type: 'system:info',
    message: `Permission mode \u2192 ${label}. Session will restart automatically.`,
  });
  ctx.setModeChangeRestart(true);
  // terminateKilled=true ensures onExit transitions to 'idle' (not 'ended').
  ctx.setTerminateKilled(true);
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
      // Emit session:init so the frontend info panel updates the displayed model.
      await ctx.emitEvent({
        type: 'session:init',
        sessionRef: '',
        slashCommands: [],
        mcpServers: [],
        model,
      });
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
      message: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
