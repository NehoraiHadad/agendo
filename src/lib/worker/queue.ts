import PgBoss, { type Job } from 'pg-boss';
import { config } from '../config';

/** Job data shape for the run-session queue */
export interface RunSessionJobData {
  sessionId: string;
  resumeRef?: string;
}

const SESSION_QUEUE_NAME = 'run-session';

let bossInstance: PgBoss | null = null;

/**
 * Get or create the singleton pg-boss instance.
 * pg-boss auto-creates its own schema (`pgboss`) on start.
 */
export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;

  bossInstance = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: 'pgboss',
  });

  await bossInstance.start();
  // pg-boss v10 requires createQueue() before send() or work()
  await bossInstance.createQueue(SESSION_QUEUE_NAME);
  return bossInstance;
}

/**
 * Enqueue a session run job.
 * Called from API routes when creating or resuming a session.
 */
export async function enqueueSession(data: RunSessionJobData): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(SESSION_QUEUE_NAME, data, {
    expireInMinutes: 60 * 8, // Sessions can run for hours
    retryLimit: 1,
    retryDelay: 10,
  });
}

/**
 * Register the worker handler for session run jobs.
 * Called from worker/index.ts on startup.
 *
 * pg-boss v10 removed the `teamSize` option. To achieve N concurrent session
 * slots, call boss.work() N times — each call creates an independent polling
 * loop. batchSize:1 ensures each loop handles exactly one session at a time,
 * so a long-running session never blocks other sessions from starting.
 */
export async function registerSessionWorker(
  handler: (job: Job<RunSessionJobData>) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  const workerOptions = {
    batchSize: 1,
    pollingIntervalSeconds: Math.ceil(config.WORKER_POLL_INTERVAL_MS / 1000),
  };
  const jobHandler = async (jobs: Job<RunSessionJobData>[]) => {
    for (const job of jobs) {
      await handler(job);
    }
  };
  // Register 3 independent polling loops to allow up to 3 concurrent sessions.
  await boss.work<RunSessionJobData>(SESSION_QUEUE_NAME, workerOptions, jobHandler);
  await boss.work<RunSessionJobData>(SESSION_QUEUE_NAME, workerOptions, jobHandler);
  await boss.work<RunSessionJobData>(SESSION_QUEUE_NAME, workerOptions, jobHandler);
}

/**
 * Gracefully stop pg-boss (drain active jobs, stop polling).
 */
export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true, timeout: 10000 });
    bossInstance = null;
  }
}
