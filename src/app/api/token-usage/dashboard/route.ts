import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MEASURE_PY_PATHS = [
  path.join(homedir(), '.claude', 'skills', 'token-optimizer', 'scripts', 'measure.py'),
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

function findMeasurePy(): string | null {
  for (const p of MEASURE_PY_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * GET /api/token-usage/dashboard
 *
 * Generates and returns the token-optimizer HTML dashboard.
 * Creates a temporary coord dir, runs measure.py dashboard, returns the HTML.
 */
export async function GET(): Promise<Response> {
  const measurePy = findMeasurePy();
  if (!measurePy) {
    return new Response('token-optimizer is not installed', { status: 404 });
  }

  const coordDir = await mkdtemp(path.join(tmpdir(), 'token-optimizer-'));

  try {
    await execFileAsync('python3', [measurePy, 'dashboard', '--coord-path', coordDir], {
      timeout: 120_000,
      cwd: homedir(),
      env: { ...process.env, DISPLAY: '' }, // suppress browser-open attempt
    });

    const dashboardPath = path.join(coordDir, 'analysis', 'dashboard.html');
    if (!existsSync(dashboardPath)) {
      return new Response('Dashboard generation failed — no output file', { status: 500 });
    }

    const html = await readFile(dashboardPath, 'utf-8');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(`Dashboard error: ${msg}`, { status: 500 });
  } finally {
    await rm(coordDir, { recursive: true, force: true }).catch(() => {});
  }
}
