import { db } from '@/lib/db';
import { sessions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * SessionHeartbeat keeps the sessions.heartbeat_at column current while a
 * SessionProcess is running. The stale-reaper uses this to detect orphaned
 * sessions whose worker process was killed without a clean shutdown.
 */
export class SessionHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly sessionId: string) {}

  start(): void {
    void this.beat();
    this.timer = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async beat(): Promise<void> {
    try {
      await db
        .update(sessions)
        .set({ heartbeatAt: new Date() })
        .where(eq(sessions.id, this.sessionId));
    } catch (err) {
      console.error(`[session-heartbeat] Failed for session ${this.sessionId}:`, err);
    }
  }
}
