/**
 * Version check service.
 *
 * Compares the current app version against git tags on origin.
 * Results are cached to `/tmp/agendo-version-check.json` to avoid
 * repeated `git fetch` calls. Cache TTL is configurable via
 * VERSION_CHECK_INTERVAL_HOURS env var (default: 24).
 */

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getCurrentVersion, parseVersion, compareVersions } from '@/lib/version';

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string;
}

const CACHE_PATH = '/tmp/agendo-version-check.json';
const DEFAULT_TTL_HOURS = 24;

function getCacheTtlMs(): number {
  const hours = Number(process.env.VERSION_CHECK_INTERVAL_HOURS) || DEFAULT_TTL_HOURS;
  return hours * 60 * 60 * 1000;
}

/** Read cached result if it exists and is within TTL. */
function readCache(): VersionCheckResult | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = readFileSync(CACHE_PATH, 'utf-8');
    const cached = JSON.parse(raw) as VersionCheckResult;
    const age = Date.now() - new Date(cached.checkedAt).getTime();
    if (age > getCacheTtlMs()) return null;
    return cached;
  } catch {
    return null;
  }
}

/** Persist result to cache file. */
function writeCache(result: VersionCheckResult): void {
  try {
    const dir = dirname(CACHE_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(result, null, 2), 'utf-8');
  } catch {
    // Non-critical — ignore cache write failures
  }
}

/** Run a git command and return stdout. */
function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { timeout: 10_000, encoding: 'utf-8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Find the highest semver tag from a list of tag strings. */
function findHighestVersion(tags: string[]): string | null {
  let highest: string | null = null;

  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const parsed = parseVersion(trimmed);
    if (!parsed) continue; // skip non-semver tags

    if (highest === null || compareVersions(trimmed, highest) === 1) {
      highest = trimmed.replace(/^v/, '');
    }
  }

  return highest;
}

export interface CheckOptions {
  /** Bypass cache and perform a fresh check. */
  forceRefresh?: boolean;
}

/**
 * Check for available updates by comparing current version against git tags.
 *
 * 1. Attempts `git fetch --tags origin` to get latest tags (10s timeout).
 * 2. Lists all `v*` tags and finds the highest semver.
 * 3. Compares against current version.
 * 4. Caches result for TTL period.
 */
export async function checkForUpdates(opts?: CheckOptions): Promise<VersionCheckResult> {
  const forceRefresh = opts?.forceRefresh ?? false;

  // Check cache first (unless force refresh)
  if (!forceRefresh) {
    const cached = readCache();
    if (cached) return cached;
  }

  const currentVersion = getCurrentVersion();

  // Fetch latest tags from origin (best-effort, non-blocking)
  try {
    await runGit(['fetch', '--tags', 'origin']);
  } catch {
    // Network error — continue with local tags
  }

  // List all version tags
  let tags: string[] = [];
  try {
    const output = await runGit(['tag', '-l', 'v*']);
    tags = output.split('\n').filter(Boolean);
  } catch {
    // No git repo or no tags — return empty
  }

  const latestVersion = findHighestVersion(tags);
  const updateAvailable =
    latestVersion !== null && compareVersions(latestVersion, currentVersion) === 1;

  const result: VersionCheckResult = {
    currentVersion,
    latestVersion,
    updateAvailable,
    checkedAt: new Date().toISOString(),
  };

  writeCache(result);

  return result;
}
