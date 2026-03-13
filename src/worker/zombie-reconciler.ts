import { db } from '../lib/db/index';
import { sessions, brainstormRooms } from '../lib/db/schema';
import { eq, and, inArray, lt, sql } from 'drizzle-orm';
import { enqueueSession } from '../lib/worker/queue';
import { enqueueBrainstorm, BRAINSTORM_QUEUE_NAME } from '../lib/worker/brainstorm-queue';
import { createLogger } from '@/lib/logger';
import { broadcastSessionStatus } from '@/lib/realtime/pg-notify';

const log = createLogger('zombie-reconciler');

// ============================================================================
// Shared constants & utilities
// ============================================================================

/**
 * Maximum number of times any entity can be auto-recovered per worker
 * lifecycle before we give up. Prevents infinite restart loops after a
 * persistent crash. The counter resets when the entity completes a full
 * successful turn (sessions) or when the worker restarts (all counters
 * live only in memory).
 */
const MAX_AUTO_RECOVERY_ATTEMPTS = 3;

/**
 * Generic in-memory recovery counter. One instance per entity type.
 * Lives only for the duration of the worker process — intentional.
 */
class RecoveryCounter {
  private readonly counts = new Map<string, number>();

  get(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  /** Increment and return the NEW count. */
  increment(id: string): number {
    const next = this.get(id) + 1;
    this.counts.set(id, next);
    return next;
  }

  reset(id: string): void {
    this.counts.delete(id);
  }

  hasReachedLimit(id: string): boolean {
    return this.get(id) >= MAX_AUTO_RECOVERY_ATTEMPTS;
  }
}

const sessionRecoveryCounter = new RecoveryCounter();
const brainstormRecoveryCounter = new RecoveryCounter();

// ============================================================================
// Public API
// ============================================================================

/**
 * On cold start: reconcile all orphaned entity types.
 * Sessions are scoped to this worker (via workerId).
 * Brainstorm rooms are global (no workerId) — checked via pg-boss job state.
 */
export async function reconcileZombies(workerId: string): Promise<void> {
  await reconcileOrphanedSessions(workerId);
  await reconcileOrphanedBrainstorms();
}

/** Reset the session recovery counter when a session completes a full turn. */
export function resetRecoveryCount(sessionId: string): void {
  sessionRecoveryCounter.reset(sessionId);
}

// ============================================================================
// Session reconciliation
// ============================================================================

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

  log.info({ count: orphaned.length }, 'Found orphaned sessions, reconciling');

  for (const session of orphaned) {
    // -----------------------------------------------------------------------
    // awaiting_input sessions: DON'T KILL the process.
    // The CLI is just sitting idle waiting for stdin. There's no unread output.
    // Let it die naturally on its own idle timeout. Just release the DB claim
    // so the cold-resume path can start a fresh process on the next message.
    // -----------------------------------------------------------------------
    if (session.status === 'awaiting_input') {
      await db
        .update(sessions)
        .set({ status: 'idle', workerId: null, pid: null, lastActiveAt: new Date() })
        .where(and(eq(sessions.id, session.id), eq(sessions.status, 'awaiting_input')));

      log.info({ sessionId: session.id }, 'Session was awaiting_input, marked idle (not killed)');
      await broadcastSessionStatus(session.id, 'idle');
      continue;
    }

    // -----------------------------------------------------------------------
    // active sessions: the agent is producing output that nobody is reading.
    // Kill the process and optionally re-enqueue for auto-recovery.
    // -----------------------------------------------------------------------
    if (session.pid != null && session.pid !== 0 && isPidAlive(session.pid)) {
      log.info({ sessionId: session.id, pid: session.pid }, 'Session PID still alive, killing');
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

    log.info(
      { sessionId: session.id, wasStatus: session.status },
      'Session marked idle after worker restart',
    );
    await broadcastSessionStatus(session.id, 'idle');

    // Auto-recovery: re-enqueue only if the session was active (mid-work) and
    // hasn't already been recovered too many times.
    if (session.sessionRef != null) {
      if (sessionRecoveryCounter.hasReachedLimit(session.id)) {
        log.info(
          {
            sessionId: session.id,
            attempts: MAX_AUTO_RECOVERY_ATTEMPTS,
          },
          'Session hit recovery limit, leaving idle',
        );
        sessionRecoveryCounter.reset(session.id);
        continue;
      }

      const attempt = sessionRecoveryCounter.increment(session.id);
      await enqueueSession({
        sessionId: session.id,
        resumeRef: session.sessionRef,
        resumePrompt: 'The worker restarted. Please continue where you left off.',
      });
      log.info(
        { sessionId: session.id, attempt, maxAttempts: MAX_AUTO_RECOVERY_ATTEMPTS },
        'Session re-enqueued for auto-recovery',
      );
    }
  }
}

// ============================================================================
// Brainstorm room reconciliation
// ============================================================================

/**
 * Rooms in these statuses must have an active pg-boss job.
 * If they don't, the orchestrator died mid-run and needs to be re-enqueued.
 */
const BRAINSTORM_IN_FLIGHT_STATUSES = ['active', 'synthesizing'] as const;

/**
 * How long a 'waiting' room can sit before we assume the /start call was
 * lost (network error, app crash between create and start, etc.).
 */
const STALE_WAITING_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

async function reconcileOrphanedBrainstorms(): Promise<void> {
  // Rooms that should currently have a running orchestrator job
  const inFlightRooms = await db
    .select({ id: brainstormRooms.id, status: brainstormRooms.status })
    .from(brainstormRooms)
    .where(inArray(brainstormRooms.status, [...BRAINSTORM_IN_FLIGHT_STATUSES]));

  // Rooms stuck in 'waiting' — POST /start was never called or silently failed
  const staleWaitingRooms = await db
    .select({ id: brainstormRooms.id, status: brainstormRooms.status })
    .from(brainstormRooms)
    .where(
      and(
        eq(brainstormRooms.status, 'waiting'),
        lt(brainstormRooms.createdAt, new Date(Date.now() - STALE_WAITING_THRESHOLD_MS)),
      ),
    );

  const candidates = [...inFlightRooms, ...staleWaitingRooms];
  if (candidates.length === 0) return;

  log.info({ count: candidates.length }, 'Checking brainstorm rooms for orphaned jobs');

  for (const room of candidates) {
    // Skip rooms that already have a live pg-boss job —
    // the orchestrator is running fine, nothing to do.
    if (await hasPgBossJob(BRAINSTORM_QUEUE_NAME, room.id)) continue;

    if (brainstormRecoveryCounter.hasReachedLimit(room.id)) {
      log.warn(
        { roomId: room.id, status: room.status, attempts: MAX_AUTO_RECOVERY_ATTEMPTS },
        'Brainstorm hit recovery limit, leaving as-is',
      );
      brainstormRecoveryCounter.reset(room.id);
      continue;
    }

    const attempt = brainstormRecoveryCounter.increment(room.id);
    // singletonKey in enqueueBrainstorm prevents duplicate jobs if one
    // somehow appeared between our check and the enqueue call.
    await enqueueBrainstorm({ roomId: room.id });
    log.info(
      { roomId: room.id, status: room.status, attempt, maxAttempts: MAX_AUTO_RECOVERY_ATTEMPTS },
      'Brainstorm re-enqueued after zombie detection',
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Returns true if a live pg-boss job exists for the given queue + singletonKey.
 * States 'created', 'retry', and 'active' all mean the job is in flight.
 * 'completed', 'failed', 'cancelled', 'expired' mean it's done.
 */
async function hasPgBossJob(queueName: string, singletonKey: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM pgboss.job
    WHERE name = ${queueName}
      AND singleton_key = ${singletonKey}
      AND state IN ('created', 'active', 'retry')
    LIMIT 1
  `);
  return (result.rows?.length ?? 0) > 0;
}

function isPidAlive(pid: number): boolean {
  if (pid === 0) return false; // pid=0 is not a real OS process (SDK adapters)
  try {
    process.kill(pid, 0); // signal 0 = check existence only, no signal sent
    return true;
  } catch {
    return false;
  }
}
