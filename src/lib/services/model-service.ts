import { readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelOption {
  id: string;
  label: string;
  description: string;
}

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
// Helper: safe spawn wrapper (no shell, no injection risk)
// ---------------------------------------------------------------------------

/** Spawn a process, write to stdin, collect stdout. Uses spawn (no shell). */
function safeSpawnWithStdin(
  cmd: string,
  args: string[],
  stdin: string,
  opts: { timeout?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    const timeout = opts.timeout ?? 15000;

    const proc = cp.spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('safeSpawnWithStdin timeout'));
    }, timeout);

    proc.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

/** Spawn a process and collect stdout. Uses execFile (no shell). */
function safeExecFile(
  cmd: string,
  args: string[],
  opts: { maxBuffer?: number; timeout?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    cp.execFile(cmd, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * Spawn two processes piped together: cmd1 | cmd2.
 * Both use spawn (no shell). Returns cmd2's stdout.
 */
function safePipe(
  cmd1: string,
  args1: string[],
  cmd2: string,
  args2: string[],
  opts: { timeout?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    const timeout = opts.timeout ?? 15000;

    const proc1 = cp.spawn(cmd1, args1, { stdio: ['ignore', 'pipe', 'ignore'] });
    const proc2 = cp.spawn(cmd2, args2, { stdio: [proc1.stdout, 'pipe', 'ignore'] });

    const chunks: Buffer[] = [];
    proc2.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      proc1.kill();
      proc2.kill();
      reject(new Error('safePipe timeout'));
    }, timeout);

    proc2.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    proc2.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc1.on('error', (err) => {
      clearTimeout(timer);
      proc2.kill();
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Codex: use `model/list` JSON-RPC via app-server protocol
// ---------------------------------------------------------------------------

/**
 * Query Codex models via the `model/list` JSON-RPC method on `codex app-server`.
 * This is the official protocol used by VS Code, macOS app, and JetBrains plugins.
 * Falls back to reading ~/.codex/models_cache.json if app-server fails.
 */
async function readCodexModels(): Promise<ModelOption[]> {
  try {
    return await readCodexModelsViaAppServer();
  } catch {
    return readCodexModelsFromCache();
  }
}

interface CodexAppServerModel {
  id?: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
}

async function readCodexModelsViaAppServer(): Promise<ModelOption[]> {
  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      clientInfo: { name: 'agendo', version: '1.0.0' },
      protocolVersion: '2025-01-01',
    },
  });
  const modelListMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'model/list',
    params: {},
  });

  const stdin = initMsg + '\n' + modelListMsg + '\n';
  const stdout = await safeSpawnWithStdin('codex', ['app-server'], stdin, { timeout: 10000 });

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as {
        id?: number;
        result?: { data?: CodexAppServerModel[] };
      };
      if (parsed.id === 2 && parsed.result?.data) {
        return parsed.result.data.flatMap((m) => {
          if (m.hidden || !m.id) return [];
          return [
            {
              id: m.id,
              label: m.displayName ?? m.id,
              description: m.description ?? m.id,
            },
          ];
        });
      }
    } catch {
      // Not valid JSON line
    }
  }
  throw new Error('No model/list response from codex app-server');
}

async function readCodexModelsFromCache(): Promise<ModelOption[]> {
  try {
    const cachePath = join(homedir(), '.codex', 'models_cache.json');
    const raw = await readFile(cachePath, 'utf-8');
    const data = JSON.parse(raw) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        description?: string;
        visibility?: string;
      }>;
    };
    if (!Array.isArray(data.models)) return [];
    return data.models.flatMap((m) => {
      if (m.visibility !== 'list' || !m.slug) return [];
      return [
        {
          id: m.slug,
          label: m.display_name ?? m.slug,
          description: m.description ?? m.slug,
        },
      ];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Claude: extract model picker entries from the CLI binary via `strings`
// ---------------------------------------------------------------------------

/**
 * Parse Claude CLI binary for model picker entries.
 *
 * No official `claude model list` command exists (feature request:
 * github.com/anthropics/claude-code/issues/12612). The binary embeds
 * `descriptionForModel` strings like:
 *   "Opus 4.6 - most capable for complex work"
 *   "Sonnet 4.6 - best for everyday tasks..."
 *
 * We pipe `strings` into `grep` to avoid buffering the full ~35MB output.
 * This is fragile but currently the only option without an API key.
 */
async function readClaudeModels(): Promise<ModelOption[]> {
  try {
    const binaryPath = await resolveClaudeBinary();
    if (!binaryPath) return [];

    const stdout = await safePipe(
      'strings',
      [binaryPath],
      'grep',
      ['-P', '^(Opus|Sonnet|Haiku) [\\d.]+( with 1M context window)? - '],
      { timeout: 15000 },
    );

    const pickerRegex = /^(Opus|Sonnet|Haiku) ([\d.]+)(?: with 1M context window)? - (.+)$/gm;
    const models: ModelOption[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = pickerRegex.exec(stdout)) !== null) {
      const fullLine = match[0];
      const family = match[1];
      const version = match[2];
      const description = match[3];
      const is1M = fullLine.includes('with 1M context window');

      const versionParts = version.split('.');
      const shortId =
        'claude-' + family.toLowerCase() + '-' + versionParts.join('-') + (is1M ? '-1m' : '');

      if (seen.has(shortId)) continue;
      seen.add(shortId);

      models.push({
        id: shortId,
        label: `${family} ${version}${is1M ? ' (1M)' : ''}`,
        description,
      });
    }

    return models;
  } catch {
    return [];
  }
}

/** Resolve the claude binary path following symlinks. */
async function resolveClaudeBinary(): Promise<string | null> {
  const candidates = [
    join(homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const candidate of candidates) {
    try {
      return await realpath(candidate);
    } catch {
      continue;
    }
  }
  try {
    const stdout = await safeExecFile('which', ['claude'], { timeout: 5000 });
    const path = stdout.trim();
    if (path) return await realpath(path);
  } catch {
    // not found
  }
  return null;
}

// ---------------------------------------------------------------------------
// Gemini: require() the models.js module from @google/gemini-cli-core
// ---------------------------------------------------------------------------

/**
 * Read model list from Gemini CLI's installed `models.js` module.
 *
 * No official `gemini --list-models` command exists. The models.js file
 * from @google/gemini-cli-core exports named constants (DEFAULT_GEMINI_MODEL,
 * VALID_GEMINI_MODELS set, etc.). We require() the module directly instead
 * of regex parsing -- more robust against formatting changes.
 *
 * Also checks ~/.gemini/settings.json for previewFeatures to include
 * preview models when enabled.
 */
async function readGeminiModels(): Promise<ModelOption[]> {
  try {
    const modelsJsPath = await findGeminiModelsJs();
    if (!modelsJsPath) return [];

    // Parse exported constants from models.js via regex.
    // Avoids dynamic require() which Turbopack can't resolve, and avoids
    // eval/vm which execute arbitrary code.
    const { readFile: rf } = await import('node:fs/promises');
    const code = await rf(modelsJsPath, 'utf-8');
    const m: Record<string, string> = {};
    for (const match of code.matchAll(/export\s+const\s+(\w+)\s*=\s*['"]([^'"]+)['"]/g)) {
      m[match[1]] = match[2];
    }

    const previewEnabled = await isGeminiPreviewEnabled();
    const models: ModelOption[] = [];

    // Primary model (pro)
    const proModel = previewEnabled
      ? (m['PREVIEW_GEMINI_MODEL'] as string | undefined)
      : (m['DEFAULT_GEMINI_MODEL'] as string | undefined);
    if (proModel) {
      models.push({
        id: proModel,
        label: formatGeminiLabel(proModel),
        description: previewEnabled ? 'Pro - preview' : 'Pro - default',
      });
    }

    // Flash model
    const flashModel = m['DEFAULT_GEMINI_FLASH_MODEL'] as string | undefined;
    if (flashModel) {
      models.push({
        id: flashModel,
        label: formatGeminiLabel(flashModel),
        description: 'Flash - fast',
      });
    }

    // Flash Lite model
    const flashLiteModel = m['DEFAULT_GEMINI_FLASH_LITE_MODEL'] as string | undefined;
    if (flashLiteModel) {
      models.push({
        id: flashLiteModel,
        label: formatGeminiLabel(flashLiteModel),
        description: 'Flash Lite - cheapest',
      });
    }

    // If preview is enabled and there's a stable pro version too, add it
    const stablePro = m['DEFAULT_GEMINI_MODEL'] as string | undefined;
    if (previewEnabled && stablePro && proModel !== stablePro) {
      models.push({
        id: stablePro,
        label: formatGeminiLabel(stablePro),
        description: 'Pro - stable',
      });
    }

    // Auto aliases
    const previewAuto = m['PREVIEW_GEMINI_MODEL_AUTO'] as string | undefined;
    const defaultAuto = m['DEFAULT_GEMINI_MODEL_AUTO'] as string | undefined;
    if (previewEnabled && previewAuto) {
      models.push({
        id: previewAuto,
        label: 'Auto (Preview)',
        description: 'Automatic model selection (preview)',
      });
    }
    if (defaultAuto) {
      models.push({ id: defaultAuto, label: 'Auto', description: 'Automatic model selection' });
    }
    const autoAlias = m['GEMINI_MODEL_ALIAS_AUTO'] as string | undefined;
    if (autoAlias && autoAlias !== defaultAuto && autoAlias !== previewAuto) {
      models.push({ id: autoAlias, label: 'Auto', description: 'Automatic model selection' });
    }

    return models;
  } catch {
    return [];
  }
}

function formatGeminiLabel(modelId: string): string {
  return modelId
    .split('-')
    .map((part) => (part === 'gemini' ? 'Gemini' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

/** Find the gemini-cli-core models.js file from the Gemini CLI installation. */
async function findGeminiModelsJs(): Promise<string | null> {
  const candidates = [
    '/usr/bin/gemini',
    '/usr/local/bin/gemini',
    join(homedir(), '.local', 'bin', 'gemini'),
  ];
  for (const candidate of candidates) {
    try {
      const realBin = await realpath(candidate);
      const pkgRoot = dirname(dirname(realBin));
      const modelsPath = join(
        pkgRoot,
        'node_modules',
        '@google',
        'gemini-cli-core',
        'dist',
        'src',
        'config',
        'models.js',
      );
      await readFile(modelsPath, 'utf-8'); // verify it exists
      return modelsPath;
    } catch {
      continue;
    }
  }
  return null;
}

/** Check ~/.gemini/settings.json for previewFeatures flag. */
async function isGeminiPreviewEnabled(): Promise<boolean> {
  try {
    const settingsPath = join(homedir(), '.gemini', 'settings.json');
    const raw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(raw) as { general?: { previewFeatures?: boolean } };
    return settings.general?.previewFeatures === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the stable default model for a provider by reading from the CLI tool's
 * local data (e.g. Gemini's models.js, Codex's app-server protocol).
 * Returns null if model discovery fails -- callers should let the CLI choose.
 */
export async function getDefaultModel(provider: Provider): Promise<string | null> {
  const models = await getModelsForProvider(provider);
  if (models.length === 0) return null;
  if (provider === 'google') {
    const stable = models.find(
      (m) => m.description.includes('stable') || m.description === 'Pro - default',
    );
    if (stable) return stable.id;
  }
  return models[0].id;
}

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
