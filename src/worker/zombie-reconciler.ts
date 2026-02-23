import { db } from '../lib/db/index';
import { executions, sessions } from '../lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { enqueueSession } from '../lib/worker/queue';

/**
 * On cold start: find executions that were 'running' or 'cancelling'
 * for this worker, check if their PIDs are still alive, and mark
 * dead ones as failed. Also recovers orphaned sessions.
 */
export async function reconcileZombies(workerId: string): Promise<void> {
  const orphaned = await db
    .select({ id: executions.id, pid: executions.pid })
    .from(executions)
    .where(
      and(eq(executions.workerId, workerId), inArray(executions.status, ['running', 'cancelling'])),
    );

  if (orphaned.length === 0) {
    console.log('[worker] No orphaned executions found.');
  } else {
    console.log(`[worker] Found ${orphaned.length} orphaned execution(s). Reconciling...`);

    for (const exec of orphaned) {
      const isAlive = exec.pid ? isPidAlive(exec.pid) : false;

      if (!isAlive) {
        await db
          .update(executions)
          .set({
            status: 'failed',
            endedAt: new Date(),
            error: 'Worker restarted, execution orphaned',
          })
          .where(eq(executions.id, exec.id));
        console.log(`[worker] Marked execution ${exec.id} as failed (orphaned).`);
      } else {
        // Rare: PID still alive after restart. Send SIGTERM, handle normally.
        console.log(`[worker] Execution ${exec.id} PID ${exec.pid} still alive. Sending SIGTERM.`);
        try {
          process.kill(exec.pid as number, 'SIGTERM');
        } catch {
          // PID may have died between check and kill -- that's fine
        }
      }
    }
  }

  await reconcileOrphanedSessions(workerId);
}

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
    if (session.pid != null && isPidAlive(session.pid)) {
      // Process is still alive but the worker that owned it died — kill the orphan.
      // Without a managing SessionProcess, Claude's output is unread and no onExit
      // callback will update the DB. Kill it now so it can be cleanly recovered.
      console.log(
        `[zombie] Session ${session.id} PID ${session.pid} still alive but orphaned — killing`,
      );
      try {
        // Kill the entire process group (negative PID = process group leader)
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

    if (session.status === 'active' && session.sessionRef != null) {
      await db
        .update(sessions)
        .set({ initialPrompt: 'The worker restarted. Please continue where you left off.' })
        .where(eq(sessions.id, session.id));

      await enqueueSession({ sessionId: session.id, resumeRef: session.sessionRef });
      console.log(`[zombie] Session ${session.id} re-enqueued for auto-recovery`);
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence, don't send signal
    return true;
  } catch {
    return false;
  }
}
