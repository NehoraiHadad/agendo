import { db } from '../lib/db/index';
import { executions } from '../lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

/**
 * On cold start: find executions that were 'running' or 'cancelling'
 * for this worker, check if their PIDs are still alive, and mark
 * dead ones as failed.
 */
export async function reconcileZombies(workerId: string): Promise<void> {
  const orphaned = await db
    .select({ id: executions.id, pid: executions.pid })
    .from(executions)
    .where(
      and(
        eq(executions.workerId, workerId),
        inArray(executions.status, ['running', 'cancelling']),
      ),
    );

  if (orphaned.length === 0) {
    console.log('[worker] No orphaned executions found.');
    return;
  }

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
        process.kill(exec.pid!, 'SIGTERM');
      } catch {
        // PID may have died between check and kill -- that's fine
      }
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
