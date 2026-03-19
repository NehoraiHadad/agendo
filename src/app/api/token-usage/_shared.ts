import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

export const MEASURE_PY_PATHS = [
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

export function findMeasurePy(): string | null {
  for (const p of MEASURE_PY_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}
