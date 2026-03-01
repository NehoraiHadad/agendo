import type { ModelOption } from '@/lib/services/provider-introspection';
import {
  readClaudeModels,
  readCodexModels,
  readGeminiModels,
} from '@/lib/services/provider-introspection';
export type { ModelOption } from '@/lib/services/provider-introspection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Provider = 'anthropic' | 'openai' | 'google';

// ---------------------------------------------------------------------------
// In-memory cache (1 hour TTL)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60 * 60 * 1000;
interface CacheEntry {
  models: ModelOption[];
  fetchedAt: number;
}
const cache = new Map<Provider, CacheEntry>();

function getCached(provider: Provider): ModelOption[] | null {
  const entry = cache.get(provider);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(provider);
    return null;
  }
  return entry.models;
}

function setCache(provider: Provider, models: ModelOption[]) {
  cache.set(provider, { models, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get models for a given provider by reading from the CLI tool's local data. */
export async function getModelsForProvider(provider: Provider): Promise<ModelOption[]> {
  const cached = getCached(provider);
  if (cached) return cached;

  let models: ModelOption[];
  switch (provider) {
    case 'openai':
      models = await readCodexModels();
      break;
    case 'anthropic':
      models = await readClaudeModels();
      break;
    case 'google':
      models = await readGeminiModels();
      break;
  }

  setCache(provider, models);
  return models;
}

/** Map provider name used in query params to Provider type. */
export function resolveProvider(param: string): Provider | null {
  const lower = param.toLowerCase();
  if (lower === 'claude' || lower === 'anthropic') return 'anthropic';
  if (lower === 'codex' || lower === 'openai') return 'openai';
  if (lower === 'gemini' || lower === 'google') return 'google';
  return null;
}
