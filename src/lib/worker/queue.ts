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

/** Job data shape for the analyze-agent queue */
export interface AnalyzeAgentJobData {
  agentId: string;
  binaryPath: string;
  toolName: string;
}

const QUEUE_NAME = 'execute-capability';
const SESSION_QUEUE_NAME = 'run-session';
const ANALYZE_QUEUE_NAME = 'analyze-agent';

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
  await bossInstance.createQueue(ANALYZE_QUEUE_NAME);
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
 * Enqueue an agent analysis job.
 * Called from the analyze API route.
 */
export async function enqueueAnalysis(data: AnalyzeAgentJobData): Promise<string> {
  const boss = await getBoss();
  const id = await boss.send(ANALYZE_QUEUE_NAME, data, {
    expireInMinutes: 5,
    retryLimit: 0,
  });
  if (!id) throw new Error('Failed to enqueue analysis job');
  return id;
}

/**
 * Get the current state of an analysis job by ID.
 * Returns the job object (with state, output, data) or null if not found.
 */
export async function getAnalysisJob(
  jobId: string,
): Promise<{ state: string; output?: unknown } | null> {
  const boss = await getBoss();
  // pg-boss v10: getJobById(queue, id)
  const job = await boss.getJobById(ANALYZE_QUEUE_NAME, jobId);
  if (!job) return null;
  return { state: job.state, output: job.output };
}

/**
 * Register the worker handler for agent analysis jobs.
 * Called from worker/index.ts on startup.
 */
export async function registerAnalysisWorker(
  handler: (job: Job<AnalyzeAgentJobData>) => Promise<unknown>,
): Promise<void> {
  const boss = await getBoss();
  // batchSize: 1 — pg-boss uses the callback return value as job output (manager.js:217)
  await boss.work<AnalyzeAgentJobData>(
    ANALYZE_QUEUE_NAME,
    { batchSize: 1, pollingIntervalSeconds: 3 },
    (jobs) => handler(jobs[0]),
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
