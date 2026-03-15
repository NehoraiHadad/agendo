import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { withErrorBoundary } from '@/lib/api-handler';
import { readLatestContextWindow } from '@/lib/worker/context-window-cache';

const execFileAsync = promisify(execFile);

const MEASURE_PY_PATHS = [
  path.join(homedir(), '.claude', 'skills', 'token-optimizer', 'scripts', 'measure.py'),
  // Plugin install path (glob pattern would be needed for exact match; try common cache location)
  path.join(
    homedir(),
    '.claude',
    'plugins',
    'cache',
    'token-optimizer',
    'skills',
    'token-optimizer',
    'scripts',
    'measure.py',
  ),
];

const SNAPSHOT_PATH = path.join(
  homedir(),
  '.claude',
  '_backups',
  'token-optimizer',
  'snapshot_current.json',
);

function findMeasurePy(): string | null {
  for (const p of MEASURE_PY_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * GET /api/token-usage
 *
 * Runs measure.py snapshot current and returns the parsed JSON snapshot.
 * Returns 404 if measure.py is not installed.
 * Returns 500 if the subprocess fails.
 */
export const GET = withErrorBoundary(async () => {
  const measurePy = findMeasurePy();
  if (!measurePy) {
    return NextResponse.json(
      {
        error: 'not_installed',
        message:
          'token-optimizer is not installed. Run: /plugin marketplace add alexgreensh/token-optimizer',
      },
      { status: 404 },
    );
  }

  // Run snapshot + coach in parallel (coach is non-fatal)
  let coachResult: { stdout: string } | null = null;
  try {
    const [, coachRes] = await Promise.all([
      execFileAsync('python3', [measurePy, 'snapshot', 'current'], {
        timeout: 30_000,
        // Run from home dir so cwd-based project detection falls back gracefully
        cwd: homedir(),
      }),
      execFileAsync('python3', [measurePy, 'coach', '--json'], {
        timeout: 30_000,
        cwd: homedir(),
      }).catch(() => null),
    ]);
    coachResult = coachRes;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: 'subprocess_failed', message: `measure.py failed: ${msg}` },
      { status: 500 },
    );
  }

  if (!existsSync(SNAPSHOT_PATH)) {
    return NextResponse.json(
      { error: 'no_snapshot', message: 'Snapshot file not found after running measure.py' },
      { status: 500 },
    );
  }

  const raw = await readFile(SNAPSHOT_PATH, 'utf-8');
  const snapshot = JSON.parse(raw) as Record<string, unknown>;

  // Inject context_window from the live cache (written by session-process.ts on every
  // agent:result event) so the value is always accurate regardless of what measure.py
  // has hardcoded. Cache wins over measure.py's static value.
  const liveContextWindow = readLatestContextWindow();
  if (liveContextWindow) {
    snapshot.context_window = liveContextWindow;
  }

  let coachData: Record<string, unknown> | null = null;
  if (coachResult?.stdout) {
    try {
      coachData = JSON.parse(coachResult.stdout) as Record<string, unknown>;
    } catch {
      // ignore parse errors — coach data is best-effort
    }
  }

  return NextResponse.json({ data: snapshot, coach: coachData });
});
