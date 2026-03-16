/**
 * Atomically claim a session row for execution.
 * Returns the claimed eventSeq on success, or null if already claimed.
 */

import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { createLogger } from '@/lib/logger';

const log = createLogger('session-claim');

export async function claimSession(
  sessionId: string,
  workerId: string,
): Promise<{ eventSeq: number } | null> {
  // Claim from 'idle', 'ended', or 'awaiting_input' — never from 'active'.
  // The zombie reconciler resets orphaned 'active' sessions to 'idle' before
  // re-enqueueing. Allowing 'active' here caused a double-claim race.
  //
  // 'awaiting_input' is included because: when a session's process dies while
  // in awaiting_input (e.g. idle timeout, crash, or orphaned by a worker
  // restart), the DB status stays 'awaiting_input' until onExit runs. If the
  // process is gone from the worker's in-memory maps, the message route's
  // cold-resume fallback enqueues a new job — which needs to claim the session.
  // The runSession guard (allSessionProcs.has check) prevents double-claiming
  // sessions that still have a live process on this worker.
  const [claimed] = await db
    .update(sessions)
    .set({
      status: 'active',
      workerId,
      startedAt: new Date(),
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(sessions.id, sessionId),
        inArray(sessions.status, ['idle', 'ended', 'awaiting_input']),
      ),
    )
    .returning({ id: sessions.id, eventSeq: sessions.eventSeq });

  if (!claimed) {
    log.info({ sessionId }, 'Session not claimable (status is active or unknown) — skipping');
    return null;
  }

  log.info({ sessionId, workerId }, 'Session claimed');
  return { eventSeq: claimed.eventSeq };
}
