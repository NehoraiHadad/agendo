import { db } from '../lib/db/index';
import { sessions } from '../lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { enqueueSession } from '../lib/worker/queue';

/**
 * On cold start: find sessions that were 'active' or 'awaiting_input'
 * for this worker and recover them.
 */
export async function reconcileZombies(workerId: string): Promise<void> {
  await reconcileOrphanedSessions(workerId);
}

/**
 * Maximum number of times a session can be auto-recovered before we stop
 * re-enqueueing. Prevents infinite kill→restart loops during rapid worker
 * restarts. The counter resets when a session completes a full turn (the
 * heartbeat update in session-process resets it).
 */
const MAX_AUTO_RECOVERY_ATTEMPTS = 3;

async function reconcileOrphanedSessions(workerId: string): Promise<void> {
  const orphaned = await db
    .select({
      id: sessions.id,
      pid: sessions.pid,
      status: sessions.status,
      sessionRef: sessions.sessionRef,
    })
    .from(sessions)
    .where(
      and(eq(sessions.workerId, workerId), inArray(sessions.status, ['active', 'awaiting_input'])),
    );

  if (orphaned.length === 0) return;

  console.log(`[zombie] Found ${orphaned.length} orphaned session(s). Reconciling...`);

  for (const session of orphaned) {
    // -----------------------------------------------------------------------
    // awaiting_input sessions: DON'T KILL the process.
    // The CLI is just sitting idle waiting for stdin. There's no unread output.
    // Let it die naturally on its own idle timeout. Just release the DB claim
    // so the cold-resume path can start a fresh process on the next message.
    // -----------------------------------------------------------------------
    if (session.status === 'awaiting_input') {
      // Don't kill the PID — it's harmlessly idle. Just disown it in the DB.
      await db
        .update(sessions)
        .set({ status: 'idle', workerId: null, pid: null, lastActiveAt: new Date() })
        .where(and(eq(sessions.id, session.id), eq(sessions.status, 'awaiting_input')));

      console.log(
        `[zombie] Session ${session.id} (was awaiting_input) marked idle — not killed (harmless)`,
      );
      continue;
    }

    // -----------------------------------------------------------------------
    // active sessions: the agent is producing output that nobody is reading.
    // Kill the process and optionally re-enqueue for auto-recovery.
    // -----------------------------------------------------------------------
    if (session.pid != null && isPidAlive(session.pid)) {
      console.log(
        `[zombie] Session ${session.id} PID ${session.pid} still alive but orphaned — killing`,
      );
      try {
        process.kill(-session.pid, 'SIGTERM');
      } catch {
        // Already dead between check and kill — fine, fall through
      }
      // Brief pause so the process can die before we update the DB
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    await db
      .update(sessions)
      .set({ status: 'idle', workerId: null, lastActiveAt: new Date() })
      .where(
        and(eq(sessions.id, session.id), inArray(sessions.status, ['active', 'awaiting_input'])),
      );

    console.log(
      `[zombie] Session ${session.id} (was ${session.status}) marked idle — worker restarted`,
    );

    // Auto-recovery: re-enqueue only if the session was active (mid-work) and
    // hasn't already been recovered too many times. The recoveryCount tracks
    // how many times the zombie reconciler has re-enqueued this session without
    // it completing a full turn.
    if (session.sessionRef != null) {
      const recoveryCount = zombieRecoveryCount.get(session.id) ?? 0;
      if (recoveryCount >= MAX_AUTO_RECOVERY_ATTEMPTS) {
        console.log(
          `[zombie] Session ${session.id} hit recovery limit (${recoveryCount}/${MAX_AUTO_RECOVERY_ATTEMPTS}) — leaving idle, no re-enqueue`,
        );
        zombieRecoveryCount.delete(session.id);
        continue;
      }

      zombieRecoveryCount.set(session.id, recoveryCount + 1);

      await db
        .update(sessions)
        .set({ initialPrompt: 'The worker restarted. Please continue where you left off.' })
        .where(eq(sessions.id, session.id));

      await enqueueSession({ sessionId: session.id, resumeRef: session.sessionRef });
      console.log(
        `[zombie] Session ${session.id} re-enqueued for auto-recovery (attempt ${recoveryCount + 1}/${MAX_AUTO_RECOVERY_ATTEMPTS})`,
      );
    }
  }
}

/**
 * In-memory counter for how many times each session has been auto-recovered
 * by the zombie reconciler. Prevents infinite kill→restart loops.
 * Cleared when the worker process starts fresh (which is fine — the counter
 * is meant to protect within one worker lifecycle).
 */
const zombieRecoveryCount = new Map<string, number>();

/** Reset recovery counter for a session (called when a session completes work). */
export function resetRecoveryCount(sessionId: string): void {
  zombieRecoveryCount.delete(sessionId);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence, don't send signal
    return true;
  } catch {
    return false;
  }
}
