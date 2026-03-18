import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { db } from '../lib/db/index';
import { sessions, brainstormRooms } from '../lib/db/schema';
import { eq, and, inArray, lt, sql } from 'drizzle-orm';
import { enqueueSession, SESSION_QUEUE_NAME } from '../lib/worker/queue';
import { enqueueBrainstorm, BRAINSTORM_QUEUE_NAME } from '../lib/worker/brainstorm-queue';
import { createLogger } from '@/lib/logger';
import { sessionEventListeners } from '@/lib/worker/worker-sse';
import type { SessionStatus } from '@/lib/realtime/event-types';

const log = createLogger('zombie-reconciler');

/**
 * Notify in-memory SSE listeners of a session status change.
 * Used by the zombie reconciler to push status updates to connected browser tabs.
 */
function notifySessionStatus(sessionId: string, status: SessionStatus): void {
  const listeners = sessionEventListeners.get(sessionId);
  if (!listeners) return;
  const event = {
    id: 0,
    sessionId,
    ts: Date.now(),
    type: 'session:state' as const,
    status,
  };
  for (const cb of listeners) {
    try {
      cb(event);
    } catch {
      // Individual listener error — ignore
    }
  }
}

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

const brainstormRecoveryCounter = new RecoveryCounter();

// ============================================================================
// Restart marker file
// ============================================================================

/**
 * Path to the restart marker file written by `safe-restart-worker.sh`.
 * Contains `{ sessionId, ts }` identifying the session that triggered the
 * restart. The zombie-reconciler uses this to give that session a smarter
 * resumePrompt ("restart succeeded, do NOT restart again") instead of the
 * generic "continue where you left off" — which would cause the agent to
 * re-attempt the restart in an infinite loop.
 */
const RESTART_MARKER_PATH = '/tmp/agendo-restart-marker.json';

interface RestartMarker {
  sessionId: string;
  ts: number;
}

/**
 * Read and consume the restart marker file (if present).
 * Returns the sessionId that triggered the restart, or null.
 * The file is deleted after reading to prevent stale markers.
 */
function consumeRestartMarker(): string | null {
  if (!existsSync(RESTART_MARKER_PATH)) return null;
  try {
    const raw = readFileSync(RESTART_MARKER_PATH, 'utf-8');
    const marker: RestartMarker = JSON.parse(raw);
    unlinkSync(RESTART_MARKER_PATH);
    // Ignore markers older than 5 minutes (stale from a previous crash)
    if (Date.now() / 1000 - marker.ts > 300) {
      log.info({ marker }, 'Ignoring stale restart marker (>5 min old)');
      return null;
    }
    log.info({ sessionId: marker.sessionId }, 'Consumed restart marker');
    return marker.sessionId;
  } catch (err) {
    log.warn({ err }, 'Failed to read restart marker file');
    try {
      unlinkSync(RESTART_MARKER_PATH);
    } catch {
      // best-effort cleanup
    }
    return null;
  }
}

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

/**
 * Reset the durable auto-resume counter when a session completes a full turn.
 * Fire-and-forget: errors are non-critical (the counter will reset on the next
 * successful turn anyway).
 *
 * @deprecated Prefer folding `autoResumeCount: 0` into the same DB update that
 * transitions the session to 'awaiting_input' (see session-process.ts transitionTo).
 * This function is kept as a safety net for any other call sites.
 */
export function resetRecoveryCount(sessionId: string): void {
  db.update(sessions)
    .set({ autoResumeCount: 0 })
    .where(eq(sessions.id, sessionId))
    .catch((err: unknown) => {
      log.warn({ err, sessionId }, 'Failed to reset autoResumeCount');
    });
}

// ============================================================================
// Session reconciliation
// ============================================================================

async function reconcileOrphanedSessions(workerId: string): Promise<void> {
  // Expire stale active pg-boss session jobs from crashed workers
  await expireStalePgBossJobs(SESSION_QUEUE_NAME, 30 * 60 * 1000); // 30 min

  // Read the restart marker BEFORE processing sessions. If present, it tells
  // us which session triggered the restart (via safe-restart-worker.sh) so we
  // can give it a smarter resumePrompt that prevents restart loops.
  const restartInitiatorId = consumeRestartMarker();

  const orphaned = await db
    .select({
      id: sessions.id,
      pid: sessions.pid,
      status: sessions.status,
      sessionRef: sessions.sessionRef,
      autoResumeCount: sessions.autoResumeCount,
    })
    .from(sessions)
    .where(
      and(eq(sessions.workerId, workerId), inArray(sessions.status, ['active', 'awaiting_input'])),
    );

  if (orphaned.length === 0) return;

  log.info({ count: orphaned.length, restartInitiatorId }, 'Found orphaned sessions, reconciling');

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
      notifySessionStatus(session.id, 'idle');
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
    notifySessionStatus(session.id, 'idle');

    // Auto-recovery: re-enqueue only if the session was active (mid-work),
    // has a resumable sessionRef, and hasn't exceeded the durable recovery limit.
    // The counter is stored in sessions.autoResumeCount (persisted in DB) so it
    // survives worker restarts — unlike the old in-memory RecoveryCounter.
    if (session.sessionRef != null) {
      if ((session.autoResumeCount ?? 0) >= MAX_AUTO_RECOVERY_ATTEMPTS) {
        log.warn(
          {
            sessionId: session.id,
            attempts: session.autoResumeCount,
            max: MAX_AUTO_RECOVERY_ATTEMPTS,
          },
          'Session hit durable auto-resume limit, leaving idle',
        );
        // Reset counter so manual resume by the user works again.
        await db.update(sessions).set({ autoResumeCount: 0 }).where(eq(sessions.id, session.id));
        continue;
      }

      // Atomically increment the durable counter.
      await db
        .update(sessions)
        .set({ autoResumeCount: sql`auto_resume_count + 1` })
        .where(eq(sessions.id, session.id));

      // Choose resumePrompt based on whether this session triggered the restart.
      // The initiator session gets a prompt that explicitly says "restart succeeded,
      // do NOT restart again" — preventing the infinite restart loop. Other sessions
      // get the standard "continue" prompt.
      const isInitiator = session.id === restartInitiatorId;
      const resumePrompt = isInitiator
        ? 'The worker restart you initiated completed successfully. The new code is now running. ' +
          'Do NOT attempt to restart the worker again. Continue your work from where you left off.'
        : 'The worker restarted. Please continue where you left off.';

      await enqueueSession({
        sessionId: session.id,
        resumeRef: session.sessionRef,
        resumePrompt,
        skipResumeContext: true,
      });
      log.info(
        {
          sessionId: session.id,
          isInitiator,
          attempt: (session.autoResumeCount ?? 0) + 1,
          maxAttempts: MAX_AUTO_RECOVERY_ATTEMPTS,
        },
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
  // First, expire any stale `active` pg-boss brainstorm jobs from crashed workers.
  // pg-boss marks jobs 'active' when a worker picks them up, but if the worker
  // dies mid-run the job stays 'active' forever — blocking the singletonKey.
  await expireStalePgBossJobs(BRAINSTORM_QUEUE_NAME, 30 * 60 * 1000); // 30 min

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

/**
 * Expire stale `active` pg-boss jobs that have been running longer than
 * the threshold. This happens when the worker crashes mid-job — pg-boss
 * marks the job `active` but nobody is processing it anymore. Without
 * cleanup, the singletonKey blocks new jobs for the same entity.
 */
async function expireStalePgBossJobs(queueName: string, thresholdMs: number): Promise<void> {
  const result = await db.execute(sql`
    UPDATE pgboss.job
    SET state = 'failed',
        output = '{"error": "zombie-reconciler: stale active job expired"}'::jsonb
    WHERE name = ${queueName}
      AND state = 'active'
      AND started_on < now() - make_interval(secs => ${Math.floor(thresholdMs / 1000)})
    RETURNING id, singleton_key
  `);
  const count = result.rows?.length ?? 0;
  if (count > 0) {
    log.info({ queueName, count, jobs: result.rows }, 'Expired stale active pg-boss jobs');
  }
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
