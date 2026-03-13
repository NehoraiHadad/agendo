import type { Job } from 'pg-boss';
import { getBoss } from '@/lib/worker/queue';

export const BRAINSTORM_QUEUE_NAME = 'run-brainstorm';

export interface RunBrainstormJobData {
  roomId: string;
}

/**
 * Enqueue a brainstorm orchestration job.
 * Uses a singletonKey to prevent duplicate jobs for the same room.
 */
export async function enqueueBrainstorm(data: RunBrainstormJobData): Promise<string | null> {
  const boss = await getBoss();
  // Ensure the queue exists before sending (getBoss only creates 'run-session').
  await boss.createQueue(BRAINSTORM_QUEUE_NAME);
  return boss.send(BRAINSTORM_QUEUE_NAME, data, {
    expireInMinutes: 60 * 4,
    retryLimit: 1,
    retryDelay: 10,
    singletonKey: data.roomId,
  });
}

/**
 * Register the worker handler for brainstorm orchestration jobs.
 * A single worker slot is sufficient — the orchestrator is a lightweight
 * coordinator that delegates heavy AI work to participant sessions.
 */
export async function registerBrainstormWorker(
  handler: (job: Job<RunBrainstormJobData>) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  await boss.createQueue(BRAINSTORM_QUEUE_NAME);
  await boss.work<RunBrainstormJobData>(
    BRAINSTORM_QUEUE_NAME,
    { batchSize: 1 },
    async (jobs: Job<RunBrainstormJobData>[]) => {
      for (const job of jobs) {
        await handler(job);
      }
    },
  );
}
