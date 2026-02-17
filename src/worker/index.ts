import { type Job } from 'pg-boss';
import { db, pool } from '../lib/db/index';
import { executions, workerHeartbeats } from '../lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { config } from '../lib/config';
import { type ExecuteCapabilityJobData, registerWorker, stopBoss } from '../lib/worker/queue';
import { checkDiskSpace } from './disk-check';
import { reconcileZombies } from './zombie-reconciler';

const WORKER_ID = config.WORKER_ID;

async function handleJob(job: Job<ExecuteCapabilityJobData>): Promise<void> {
  const { executionId } = job.data;
  console.log(`[worker] Claimed job for execution ${executionId}`);

  // Phase 1: stub -- mark as running, wait 1s, mark as succeeded
  await db
    .update(executions)
    .set({
      status: 'running',
      workerId: WORKER_ID,
      startedAt: new Date(),
      heartbeatAt: new Date(),
    })
    .where(eq(executions.id, executionId));

  // Simulate work (replaced with real execution runner in Phase 4)
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Cancellation race guard: only complete if still running
  const result = await db
    .update(executions)
    .set({
      status: 'succeeded',
      endedAt: new Date(),
      exitCode: 0,
    })
    .where(and(eq(executions.id, executionId), eq(executions.status, 'running')))
    .returning({ id: executions.id });

  if (result.length === 0) {
    // Status changed to 'cancelling' mid-execution -- respect cancellation
    await db
      .update(executions)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(and(eq(executions.id, executionId), eq(executions.status, 'cancelling')));
    console.log(`[worker] Execution ${executionId} was cancelled during run`);
  } else {
    console.log(`[worker] Execution ${executionId} completed successfully`);
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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[worker] Received ${signal}, shutting down...`);
    clearInterval(heartbeatInterval);
    await stopBoss();
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
