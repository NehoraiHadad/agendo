import { type Job } from 'pg-boss';
import { db, pool } from '../lib/db/index';
import { workerHeartbeats } from '../lib/db/schema';
import { config } from '../lib/config';
import {
  type ExecuteCapabilityJobData,
  type RunSessionJobData,
  type AnalyzeAgentJobData,
  registerWorker,
  registerSessionWorker,
  registerAnalysisWorker,
  stopBoss,
} from '../lib/worker/queue';
import { checkDiskSpace } from './disk-check';
import { reconcileZombies } from './zombie-reconciler';
import { runExecution } from '../lib/worker/execution-runner';
import { runSession, liveSessionProcs, allSessionProcs } from '../lib/worker/session-runner';
import { StaleReaper } from '../lib/worker/stale-reaper';
import { queryAI } from '../lib/services/ai-query-service';
import { getHelpText } from '../lib/discovery/schema-extractor';
import { buildAnalysisPrompt, extractJsonArray } from '../lib/services/analyze-service';

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

async function handleAnalysisJob(
  job: Job<AnalyzeAgentJobData>,
): Promise<{ suggestions: unknown[] }> {
  const { agentId, binaryPath, toolName } = job.data;
  console.log(`[worker] Analysis job for agent ${agentId} (${toolName})`);
  const helpText = await getHelpText(binaryPath).catch(() => null);
  const prompt = buildAnalysisPrompt(toolName, helpText);
  const { text, providerName } = await queryAI({
    prompt,
    timeoutMs: 45_000,
    preferredSlug: 'gemini-cli-1',
  });
  console.log(`[worker] Analysis got response from ${providerName}`);
  const suggestions = extractJsonArray(text);
  console.log(`[worker] Analysis parsed ${suggestions.length} suggestions`);
  return { suggestions };
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

  // Register execution job handler
  await registerWorker(handleJob);
  console.log(
    `[worker] Listening for execution jobs (max ${config.WORKER_MAX_CONCURRENT_JOBS} concurrent)...`,
  );

  // Register session job handler
  await registerSessionWorker(handleSessionJob);
  console.log(`[worker] Listening for session jobs...`);

  // Register analysis job handler
  await registerAnalysisWorker(handleAnalysisJob);
  console.log(`[worker] Listening for analysis jobs...`);

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
    // Wait for in-flight slot-holding jobs (sessions not yet at awaiting_input, executions)
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
