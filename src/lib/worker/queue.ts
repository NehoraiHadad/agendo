import PgBoss, { type Job } from 'pg-boss';
import { config } from '../config';

/** Job data shape for the execute-capability queue */
export interface ExecuteCapabilityJobData {
  executionId: string;
  capabilityId: string;
  agentId: string;
  args: Record<string, unknown>;
  sessionId?: string;
}

/** Job data shape for the run-session queue */
export interface RunSessionJobData {
  sessionId: string;
  resumeRef?: string;
}

const QUEUE_NAME = 'execute-capability';
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
  await bossInstance.createQueue(QUEUE_NAME);
  await bossInstance.createQueue(SESSION_QUEUE_NAME);
  return bossInstance;
}

/**
 * Enqueue a capability execution job.
 * Called from API routes / server actions.
 */
export async function enqueueExecution(data: ExecuteCapabilityJobData): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(QUEUE_NAME, data, {
    expireInMinutes: 45,
    retryLimit: 2,
    retryDelay: 30,
  });
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
 * Register the worker handler for capability execution jobs.
 * Called from worker/index.ts on startup.
 * pg-boss v10 delivers jobs in batches; we process one at a time.
 */
export async function registerWorker(
  handler: (job: Job<ExecuteCapabilityJobData>) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  await boss.work<ExecuteCapabilityJobData>(
    QUEUE_NAME,
    {
      batchSize: config.WORKER_MAX_CONCURRENT_JOBS,
      pollingIntervalSeconds: Math.ceil(config.WORKER_POLL_INTERVAL_MS / 1000),
    },
    async (jobs: Job<ExecuteCapabilityJobData>[]) => {
      for (const job of jobs) {
        await handler(job);
      }
    },
  );
}

/**
 * Register the worker handler for session run jobs.
 * Called from worker/index.ts on startup.
 */
export async function registerSessionWorker(
  handler: (job: Job<RunSessionJobData>) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  // teamSize: 3 = three independent polling loops running concurrently.
  // batchSize: 1 = each loop handles one session at a time.
  // This prevents a long-running session from blocking other sessions from starting.
  await boss.work<RunSessionJobData>(
    SESSION_QUEUE_NAME,
    {
      batchSize: 1,
      pollingIntervalSeconds: Math.ceil(config.WORKER_POLL_INTERVAL_MS / 1000),
    },
    async (jobs: Job<RunSessionJobData>[]) => {
      for (const job of jobs) {
        await handler(job);
      }
    },
  );
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
