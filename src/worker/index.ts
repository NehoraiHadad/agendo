import { db, pool } from '../lib/db/index';
import { workerHeartbeats } from '../lib/db/schema';
import { config } from '../lib/config';
import { checkDiskSpace } from './disk-check';
import { reconcileZombies } from './zombie-reconciler';
import { installSkills } from '../lib/worker/skills/install-skills';
import { initRuntime } from '../lib/worker/session-runner';
import { RuntimeManager } from '../lib/worker/runtime-manager';
import { runGitHubSync } from '../lib/services/github-sync-service';
import { startWorkerHttp, stopWorkerHttp } from '../lib/worker/worker-http';
import { StaleReaper } from '../lib/worker/stale-reaper';
import { createLogger } from '@/lib/logger';

const log = createLogger('worker');

const WORKER_ID = config.WORKER_ID;

/** Singleton RuntimeManager — owns all in-memory session process maps. */
export const runtimeManager = new RuntimeManager(WORKER_ID);
initRuntime(runtimeManager);

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
  log.info({ workerId: WORKER_ID }, 'Starting worker');

  // Pre-flight: disk space check
  const hasDiskSpace = await checkDiskSpace(config.LOG_DIR);
  if (!hasDiskSpace) {
    log.error('Insufficient disk space (< 5GB free). Refusing to start.');
    process.exit(1);
  }

  // Pre-flight: zombie process reconciliation
  await reconcileZombies(WORKER_ID);

  // Install/update SKILL.md files for native CLI skill discovery
  await installSkills();

  // Start Worker HTTP server for direct control/event dispatch
  startWorkerHttp();

  // GitHub sync — poll every 5 minutes via setInterval
  const GITHUB_SYNC_INTERVAL_MS = 5 * 60 * 1000;
  const githubSyncInterval = setInterval(() => {
    void (async () => {
      try {
        const results = await runGitHubSync();
        const totalCreated = results.reduce((sum, r) => sum + r.tasksCreated, 0);
        const totalUpdated = results.reduce((sum, r) => sum + r.tasksUpdated, 0);
        if (totalCreated > 0 || totalUpdated > 0) {
          log.info(
            { projects: results.length, tasksCreated: totalCreated, tasksUpdated: totalUpdated },
            'GitHub sync completed',
          );
        }
      } catch (err) {
        log.error({ err }, 'GitHub sync failed');
      }
    })();
  }, GITHUB_SYNC_INTERVAL_MS);
  // Run once immediately on startup
  void runGitHubSync().catch((err) => log.error({ err }, 'Initial GitHub sync failed'));
  log.info('GitHub sync interval started (every 5 minutes)');

  // Heartbeat loop
  const heartbeatInterval = setInterval(updateHeartbeat, config.HEARTBEAT_INTERVAL_MS);
  await updateHeartbeat(); // initial beat

  // Stale job reaper
  const staleReaper = new StaleReaper();
  staleReaper.start();
  log.info({ thresholdMs: config.STALE_JOB_THRESHOLD_MS }, 'Stale job reaper started');

  // Graceful shutdown: stop accepting new jobs, wait for in-flight sessions
  // to finish their final DB update, then close the pool.
  // kill_timeout in ecosystem.config.js must be > SHUTDOWN_GRACE_MS.
  const SHUTDOWN_GRACE_MS = 25_000;
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Received signal, shutting down');
    clearInterval(heartbeatInterval);
    clearInterval(githubSyncInterval);
    staleReaper.stop();

    // SYNCHRONOUSLY mark every known session process as terminating BEFORE any
    // await. SIGINT (and sometimes SIGTERM) is delivered to the entire process
    // group — Claude exits at the same time as us. We must set terminateKilled
    // before the I/O event loop tick that fires onExit, otherwise onExit sees
    // terminateKilled=false and emits "Session ended unexpectedly".
    runtimeManager.markAllTerminating();
    // Terminate live sessions (awaiting_input sessions whose process is still running)
    await runtimeManager.shutdown(SHUTDOWN_GRACE_MS);
    await stopWorkerHttp();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error({ err }, 'Fatal error');
  process.exit(1);
});
