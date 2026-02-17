import { db } from '@/lib/db';
import { executions } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const HEARTBEAT_INTERVAL_MS = 30_000;

export class ExecutionHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly executionId: string) {}

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
        .update(executions)
        .set({ heartbeatAt: new Date() })
        .where(eq(executions.id, this.executionId));
    } catch (err) {
      console.error(`[heartbeat] Failed for execution ${this.executionId}:`, err);
    }
  }
}
