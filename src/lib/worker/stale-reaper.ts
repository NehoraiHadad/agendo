import { db } from '@/lib/db';
import { executions, sessions } from '@/lib/db/schema';
import { eq, and, lt, inArray, sql } from 'drizzle-orm';
import { config } from '@/lib/config';

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

    // --- Reap stale executions (heartbeat lost while running) ---
    const staleRows = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        and(
          eq(executions.status, 'running'),
          lt(
            executions.heartbeatAt,
            sql`NOW() - INTERVAL '${sql.raw(String(thresholdMs))} milliseconds'`,
          ),
        ),
      );

    if (staleRows.length > 0) {
      await Promise.all(
        staleRows.map((row) =>
          db
            .update(executions)
            .set({ status: 'timed_out', error: 'Heartbeat lost — worker stale' })
            .where(and(eq(executions.id, row.id), eq(executions.status, 'running'))),
        ),
      );
    }

    // --- Reap stale sessions (heartbeat lost while active/awaiting_input) ---
    // Transition to 'idle' so they can be cold-resumed rather than permanently ended.
    const staleSessions = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          inArray(sessions.status, ['active', 'awaiting_input']),
          lt(
            sessions.heartbeatAt,
            sql`NOW() - INTERVAL '${sql.raw(String(thresholdMs))} milliseconds'`,
          ),
        ),
      );

    if (staleSessions.length > 0) {
      await Promise.all(
        staleSessions.map((row) =>
          db
            .update(sessions)
            .set({ status: 'idle', lastActiveAt: new Date() })
            .where(
              and(
                eq(sessions.id, row.id),
                inArray(sessions.status, ['active', 'awaiting_input']),
              ),
            ),
        ),
      );
    }

    return staleRows.length + staleSessions.length;
  }
}
