import { type Job } from 'pg-boss';
import { db, pool } from '../lib/db/index';
import { workerHeartbeats } from '../lib/db/schema';
import { config } from '../lib/config';
import { type RunSessionJobData, registerSessionWorker, stopBoss } from '../lib/worker/queue';
import { checkDiskSpace } from './disk-check';
import { reconcileZombies } from './zombie-reconciler';
import { runSession, liveSessionProcs, allSessionProcs } from '../lib/worker/session-runner';
import { StaleReaper } from '../lib/worker/stale-reaper';

const WORKER_ID = config.WORKER_ID;

/** Track in-flight session promises so graceful shutdown can wait for them. */
const inFlightJobs = new Set<Promise<void>>();

async function handleSessionJob(job: Job<RunSessionJobData>): Promise<void> {
  const { sessionId, resumeRef } = job.data;
  console.log(
    `[worker] slot claimed for session ${sessionId} — ${inFlightJobs.size + 1} slot(s) in use`,
  );

  const promise = (async () => {
    try {
      await runSession(sessionId, WORKER_ID, resumeRef);
      console.log(
        `[worker] slot freed for session ${sessionId} — ${liveSessionProcs.size} live session(s)`,
      );
    } catch (err) {
      console.error(`[worker] Session ${sessionId} failed:`, err);
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

  // Register session job handler
  await registerSessionWorker(handleSessionJob);
  console.log(`[worker] Listening for session jobs...`);

  // Heartbeat loop
  const heartbeatInterval = setInterval(updateHeartbeat, config.HEARTBEAT_INTERVAL_MS);
  await updateHeartbeat(); // initial beat

  // Stale job reaper
  const staleReaper = new StaleReaper();
  staleReaper.start();
  console.log(`[worker] Stale job reaper started (threshold: ${config.STALE_JOB_THRESHOLD_MS}ms)`);

  // Graceful shutdown: stop accepting new jobs, wait for in-flight sessions
  // to finish their final DB update, then close the pool.
  // kill_timeout in ecosystem.config.js must be > SHUTDOWN_GRACE_MS + stopBoss timeout.
  const SHUTDOWN_GRACE_MS = 25_000;
  const shutdown = async (signal: string) => {
    console.log(`[worker] Received ${signal}, shutting down...`);
    clearInterval(heartbeatInterval);
    staleReaper.stop();

    // SYNCHRONOUSLY mark every known session process as terminating BEFORE any
    // await. SIGINT (and sometimes SIGTERM) is delivered to the entire process
    // group — Claude exits at the same time as us. We must set terminateKilled
    // before the I/O event loop tick that fires onExit, otherwise onExit sees
    // terminateKilled=false and emits "Session ended unexpectedly".
    for (const proc of allSessionProcs.values()) {
      proc.markTerminating();
    }
    // Stop pg-boss from delivering new jobs (short timeout since we manage our own wait below)
    await stopBoss();
    // Wait for in-flight slot-holding jobs (sessions not yet at awaiting_input)
    if (inFlightJobs.size > 0) {
      console.log(`[worker] Waiting for ${inFlightJobs.size} in-flight job(s) to release slots...`);
      await Promise.race([
        Promise.allSettled([...inFlightJobs]),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
    }
    // Terminate live sessions (awaiting_input sessions whose process is still running)
    if (liveSessionProcs.size > 0) {
      console.log(`[worker] Terminating ${liveSessionProcs.size} live session(s)...`);
      const exitPromises = [...liveSessionProcs.values()].map((proc) => {
        proc.terminate();
        return proc.waitForExit();
      });
      await Promise.race([
        Promise.allSettled(exitPromises),
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
