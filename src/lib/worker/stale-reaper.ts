import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq, and, lt, sql } from 'drizzle-orm';
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

    if (staleRows.length === 0) return 0;

    await Promise.all(
      staleRows.map((row) =>
        db
          .update(executions)
          .set({ status: 'timed_out', error: 'Heartbeat lost — worker stale' })
          .where(and(eq(executions.id, row.id), eq(executions.status, 'running'))),
      ),
    );

    return staleRows.length;
  }
}
