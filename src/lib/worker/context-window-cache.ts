/**
 * Persists context window sizes reported by agent CLIs to a local JSON cache file.
 *
 * Every agent session emits contextWindow in its usage events (Claude via modelUsage,
 * Codex via thread/start, Gemini via ACP). We capture those values here so that
 * offline tools like measure.py can use the real number instead of a hardcoded constant.
 *
 * Cache file: ~/.claude/_agendo/context_window_cache.json
 * Format:
 * {
 *   "models": { "<modelId>": <contextWindow>, ... },
 *   "latest": <contextWindow>,
 *   "latestModel": "<modelId>",
 *   "updatedAt": "<ISO string>"
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@/lib/logger';

const log = createLogger('context-window-cache');

const CACHE_DIR = join(homedir(), '.claude', '_agendo');
const CACHE_PATH = join(CACHE_DIR, 'context_window_cache.json');

interface ContextWindowCache {
  models: Record<string, number>;
  latest: number;
  latestModel: string;
  updatedAt: string;
}

function readCache(): ContextWindowCache | null {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) as ContextWindowCache;
  } catch {
    return null;
  }
}

/**
 * Persists a context window value observed during a live session.
 * modelId may be null if not yet known (e.g. before system:init event);
 * the value is still stored as "latest" so measure.py can use it.
 */
export function persistContextWindow(modelId: string | null, contextWindow: number): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });

    const prev = readCache();
    const models = prev?.models ?? {};
    const key = modelId ?? 'unknown';
    models[key] = contextWindow;

    const cache: ContextWindowCache = {
      models,
      latest: contextWindow,
      latestModel: key,
      updatedAt: new Date().toISOString(),
    };

    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch (err) {
    // Non-fatal — we never want a cache write failure to break a session
    log.warn({ err }, 'Failed to write context window cache');
  }
}

/**
 * Returns the latest known context window across all models, or null if no cache exists.
 */
export function readLatestContextWindow(): number | null {
  return readCache()?.latest ?? null;
}

/**
 * Returns all known per-model context windows, or null if no cache exists.
 * Exposed in the /api/token-usage response so the settings tab can show
 * accurate values for every model the user has run.
 */
export function readAllContextWindows(): Record<string, number> | null {
  const cache = readCache();
  return cache?.models ?? null;
}

/**
 * Returns the cached context window for a specific model, falling back to the
 * latest known value, or null if no cache exists.
 *
 * Use this to pre-populate lastContextWindow at session:init time so the
 * context bar is accurate even on the very first turn (before agent:result fires).
 */
export function readContextWindowForModel(modelId: string | null): number | null {
  const cache = readCache();
  if (!cache) return null;
  if (modelId && cache.models[modelId]) return cache.models[modelId];
  return cache.latest ?? null;
}
