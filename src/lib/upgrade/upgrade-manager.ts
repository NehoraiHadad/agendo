/**
 * Upgrade manager — singleton in-memory state for one-click upgrades.
 *
 * Spawns scripts/upgrade.sh, streams its output to SSE subscribers,
 * and parses stdout lines into stage transitions.
 *
 * Module-level state is safe in production (single PM2 process).
 * Only one upgrade can run at a time (mutex enforced synchronously).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createLogger } from '@/lib/logger';
import type { UpgradeSseEvent } from './upgrade-events';

const log = createLogger('upgrade-manager');

export type UpgradeStage =
  | 'idle'
  | 'preflight'
  | 'install'
  | 'build'
  | 'migrate'
  | 'restart'
  | 'done'
  | 'failed';

export interface UpgradeJob {
  id: string;
  targetVersion: string;
  stage: UpgradeStage;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  /** Ring buffer — max 2000 lines */
  logLines: string[];
}

export interface UpgradeStatus {
  running: boolean;
  job: UpgradeJob | null;
}

export class UpgradeAlreadyRunningError extends Error {
  constructor() {
    super('An upgrade is already in progress');
    this.name = 'UpgradeAlreadyRunningError';
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

let currentJob: UpgradeJob | null = null;
const subscribers = new Map<string, Set<(evt: UpgradeSseEvent) => void>>();

const MAX_LOG_LINES = 2000;
const PROJECT_ROOT = process.cwd();
const UPGRADE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'upgrade.sh');

// ---------------------------------------------------------------------------
// Stage detection
// ---------------------------------------------------------------------------

function detectStage(line: string): UpgradeStage | null {
  const l = line.toLowerCase();
  if (l.includes('pre-flight') || l.includes('project directory') || l.includes('fetching tags')) {
    return 'preflight';
  }
  if (l.includes('installing dependencies')) return 'install';
  if (l.includes('building')) return 'build';
  if (l.includes('running database migrations')) return 'migrate';
  if (l.includes('restarting services')) return 'restart';
  if (l.includes('upgrade complete')) return 'done';
  return null;
}

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function broadcast(jobId: string, evt: UpgradeSseEvent): void {
  const subs = subscribers.get(jobId);
  if (!subs) return;
  for (const fn of subs) {
    try {
      fn(evt);
    } catch {
      // ignore subscriber errors
    }
  }
}

function appendLine(job: UpgradeJob, line: string): void {
  if (job.logLines.length >= MAX_LOG_LINES) {
    job.logLines.shift();
  }
  job.logLines.push(line);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getUpgradeStatus(): UpgradeStatus {
  if (!currentJob) return { running: false, job: null };
  const running = currentJob.stage !== 'done' && currentJob.stage !== 'failed';
  return { running, job: { ...currentJob, logLines: [...currentJob.logLines] } };
}

export function getJobLog(jobId: string): string[] {
  if (currentJob?.id !== jobId) return [];
  return [...currentJob.logLines];
}

export function subscribeToJob(jobId: string, onEvent: (evt: UpgradeSseEvent) => void): () => void {
  let subs = subscribers.get(jobId);
  if (!subs) {
    subs = new Set();
    subscribers.set(jobId, subs);
  }
  subs.add(onEvent);

  return () => {
    subscribers.get(jobId)?.delete(onEvent);
  };
}

export async function startUpgrade(targetVersion: string): Promise<{ jobId: string }> {
  // Synchronous mutex check — safe in Node.js single-threaded event loop
  if (currentJob && currentJob.stage !== 'done' && currentJob.stage !== 'failed') {
    throw new UpgradeAlreadyRunningError();
  }

  const jobId = crypto.randomUUID();
  currentJob = {
    id: jobId,
    targetVersion,
    stage: 'preflight',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    logLines: [],
  };

  log.info({ jobId, targetVersion }, 'Starting upgrade');

  const proc = spawn('/bin/bash', [UPGRADE_SCRIPT, '--force', '--to', `v${targetVersion}`], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Stream stdout and stderr via readline (line-buffered)
  const handleLine = (line: string) => {
    const job = currentJob;
    if (!job || job.id !== jobId) return;

    appendLine(job, line);
    broadcast(jobId, { type: 'log', line });

    const newStage = detectStage(line);
    if (newStage && newStage !== job.stage) {
      job.stage = newStage;
      broadcast(jobId, { type: 'stage', stage: newStage });
    }
  };

  if (proc.stdout) createInterface({ input: proc.stdout }).on('line', handleLine);
  if (proc.stderr) createInterface({ input: proc.stderr }).on('line', handleLine);

  proc.on('close', (code) => {
    const job = currentJob;
    if (!job || job.id !== jobId) return;

    job.exitCode = code;
    job.finishedAt = new Date().toISOString();

    if (code === 0) {
      job.stage = 'done';
      broadcast(jobId, { type: 'done', exitCode: 0 });
      log.info({ jobId, targetVersion }, 'Upgrade completed successfully');
    } else {
      job.stage = 'failed';
      broadcast(jobId, {
        type: 'error',
        message: `Upgrade script exited with code ${code ?? 'unknown'}`,
      });
      log.error({ jobId, targetVersion, code }, 'Upgrade failed');
    }

    // Clean up subscribers after a delay (allow final events to drain)
    setTimeout(() => subscribers.delete(jobId), 10_000);
  });

  return { jobId };
}
