import { type Job } from 'pg-boss';
import { db, pool } from '../lib/db/index';
import { workerHeartbeats } from '../lib/db/schema';
import { config } from '../lib/config';
import { type ExecuteCapabilityJobData, registerWorker, stopBoss } from '../lib/worker/queue';
import { checkDiskSpace } from './disk-check';
import { reconcileZombies } from './zombie-reconciler';
import { runExecution } from '../lib/worker/execution-runner';
import { StaleReaper } from '../lib/worker/stale-reaper';

const WORKER_ID = config.WORKER_ID;

/** Track in-flight execution promises so graceful shutdown can wait for them. */
const inFlightJobs = new Set<Promise<void>>();

async function handleJob(job: Job<ExecuteCapabilityJobData>): Promise<void> {
  const { executionId } = job.data;
  console.log(`[worker] Claimed job for execution ${executionId}`);

  const promise = (async () => {
    try {
      await runExecution({ executionId, workerId: WORKER_ID });
      console.log(`[worker] Execution ${executionId} completed`);
    } catch (err) {
      console.error(`[worker] Execution ${executionId} failed:`, err);
      throw err;
    }
  })();

  inFlightJobs.add(promise);
  try {
    await promise;
  } finally {
    inFlightJobs.delete(promise);
  }
}

async function updateHeartbeat(): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      workerId: WORKER_ID,
      lastSeenAt: new Date(),
      currentExecutions: 0,
      metadata: {},
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: { lastSeenAt: new Date() },
    });
}

async function main(): Promise<void> {
  console.log(`[worker] Starting worker ${WORKER_ID}...`);

  // Pre-flight: disk space check
  const hasDiskSpace = await checkDiskSpace(config.LOG_DIR);
  if (!hasDiskSpace) {
    console.error('[worker] Insufficient disk space (< 5GB free). Refusing to start.');
    process.exit(1);
  }

  // Pre-flight: zombie process reconciliation
  await reconcileZombies(WORKER_ID);

  // Register the job handler
  await registerWorker(handleJob);
  console.log(
    `[worker] Listening for jobs (max ${config.WORKER_MAX_CONCURRENT_JOBS} concurrent)...`,
  );

  // Heartbeat loop
  const heartbeatInterval = setInterval(updateHeartbeat, config.HEARTBEAT_INTERVAL_MS);
  await updateHeartbeat(); // initial beat

  // Stale job reaper
  const staleReaper = new StaleReaper();
  staleReaper.start();
  console.log(`[worker] Stale job reaper started (threshold: ${config.STALE_JOB_THRESHOLD_MS}ms)`);

  // Graceful shutdown: stop accepting new jobs, wait for in-flight executions
  // to finish their final DB update, then close the pool.
  // kill_timeout in ecosystem.config.js must be > SHUTDOWN_GRACE_MS + stopBoss timeout.
  const SHUTDOWN_GRACE_MS = 25_000;
  const shutdown = async (signal: string) => {
    console.log(`[worker] Received ${signal}, shutting down...`);
    clearInterval(heartbeatInterval);
    staleReaper.stop();
    // Stop pg-boss from delivering new jobs (short timeout since we manage our own wait below)
    await stopBoss();
    // Wait for in-flight executions to complete their final DB update
    if (inFlightJobs.size > 0) {
      console.log(`[worker] Waiting for ${inFlightJobs.size} in-flight execution(s) to finish...`);
      await Promise.race([
        Promise.allSettled([...inFlightJobs]),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
    }
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] Fatal error:', err);
  process.exit(1);
});
