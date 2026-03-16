import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq, and, lt, inArray, sql } from 'drizzle-orm';
import { config } from '@/lib/config';
import { createLogger } from '@/lib/logger';
import { sessionEventListeners } from '@/lib/worker/worker-sse';
import type { SessionStatus } from '@/lib/realtime/event-types';

const log = createLogger('stale-reaper');

/**
 * Notify in-memory SSE listeners of a session status change.
 * Used by the stale reaper to push status updates to connected browser tabs
 * without going through PG NOTIFY.
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

function killPid(pid: number): void {
  if (pid === 0) return; // pid=0 is not a real OS process (SDK adapters)
  try {
    // Kill entire process group (handles detached children like Gemini CLI)
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already dead — fine
    }
  }
}

export class StaleReaper {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    const interval = Math.floor(config.STALE_JOB_THRESHOLD_MS / 2);
    this.timer = setInterval(() => void this.reap(), interval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async reap(): Promise<number> {
    const thresholdMs = config.STALE_JOB_THRESHOLD_MS;
    const staleInterval = sql`NOW() - INTERVAL '${sql.raw(String(thresholdMs))} milliseconds'`;

    // --- Reap stale sessions (heartbeat lost while active/awaiting_input) ---
    // Kill orphaned OS processes, then transition to 'idle' for cold-resume.
    //
    // IMPORTANT: Re-check heartbeat freshness in the UPDATE to prevent a race
    // where a session is re-claimed (with a fresh heartbeat) between the SELECT
    // and the UPDATE. Without this guard, the UPDATE would clobber a freshly-
    // claimed session, killing it seconds after it started.
    const staleSessions = await db
      .select({ id: sessions.id, pid: sessions.pid })
      .from(sessions)
      .where(
        and(
          inArray(sessions.status, ['active', 'awaiting_input']),
          lt(sessions.heartbeatAt, staleInterval),
        ),
      );

    if (staleSessions.length > 0) {
      // Atomically mark stale sessions as idle FIRST, re-checking heartbeat
      // freshness. This prevents clobbering sessions that were re-claimed
      // between our SELECT and now.
      const reaped = await Promise.all(
        staleSessions.map((row) =>
          db
            .update(sessions)
            .set({ status: 'idle', pid: null, lastActiveAt: new Date() })
            .where(
              and(
                eq(sessions.id, row.id),
                inArray(sessions.status, ['active', 'awaiting_input']),
                lt(sessions.heartbeatAt, staleInterval),
              ),
            )
            .returning({ id: sessions.id }),
        ),
      );

      // Only kill PIDs for sessions that were actually reaped (UPDATE matched).
      // If the UPDATE was a no-op (session was re-claimed with fresh heartbeat),
      // the PID now belongs to the new session process — do NOT kill it.
      for (let i = 0; i < staleSessions.length; i++) {
        const row = staleSessions[i];
        const wasReaped = reaped[i].length > 0;
        if (wasReaped) {
          if (row.pid != null && row.pid !== 0) {
            log.info({ pid: row.pid, sessionId: row.id }, 'Killing orphaned PID for session');
            killPid(row.pid);
          }
          // Notify in-memory SSE listeners so connected browser tabs see the status change.
          notifySessionStatus(row.id, 'idle');
        }
      }

      const actuallyReaped = reaped.filter((r) => r.length > 0).length;
      if (actuallyReaped < staleSessions.length) {
        log.info(
          { skipped: staleSessions.length - actuallyReaped },
          'Skipped sessions — heartbeat refreshed (re-claimed)',
        );
      }
    }

    return staleSessions.length;
  }
}
