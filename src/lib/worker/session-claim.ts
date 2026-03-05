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
  // Only claim from 'idle' or 'ended' — never from 'active'. The zombie
  // reconciler always resets orphaned 'active' sessions back to 'idle' before
  // re-enqueueing, so a legitimate resume always starts from 'idle'. Allowing
  // 'active' here caused a double-claim race: the retried old job and the
  // reconciler's new job both claimed the same session concurrently.
  const [claimed] = await db
    .update(sessions)
    .set({
      status: 'active',
      workerId,
      startedAt: new Date(),
      heartbeatAt: new Date(),
    })
    .where(and(eq(sessions.id, sessionId), inArray(sessions.status, ['idle', 'ended'])))
    .returning({ id: sessions.id, eventSeq: sessions.eventSeq });

  if (!claimed) {
    log.info({ sessionId }, 'Session already claimed — skipping');
    return null;
  }

  log.info({ sessionId, workerId }, 'Session claimed');
  return { eventSeq: claimed.eventSeq };
}
