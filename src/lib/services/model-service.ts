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

/** Spawn a process and collect stdout. Safe against injection (no shell). */
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
 * Both use execFile semantics (no shell). Returns cmd2's stdout.
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
// Codex: read ~/.codex/models_cache.json
// ---------------------------------------------------------------------------

async function readCodexModels(): Promise<ModelOption[]> {
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
 * The binary contains `descriptionForModel` strings like:
 *   "Opus 4.6 - most capable for complex work"
 *   "Sonnet 4.6 - best for everyday tasks..."
 *   "Haiku 4.5 - fastest for quick answers..."
 *
 * We pipe `strings` into `grep` to avoid buffering the full 35MB output.
 */
async function readClaudeModels(): Promise<ModelOption[]> {
  try {
    const binaryPath = await resolveClaudeBinary();
    if (!binaryPath) return [];

    // The binary is ~35MB of strings — pipe through grep to avoid buffering it all.
    // Matches both "Opus 4.6 - ..." and "Opus 4.6 with 1M context window - ..."
    const stdout = await safePipe(
      'strings',
      [binaryPath],
      'grep',
      ['-P', '^(Opus|Sonnet|Haiku) [\\d.]+( with 1M context window)? - '],
      { timeout: 15000 },
    );

    // Pattern 1: "Family Version - description"
    // Pattern 2: "Family Version with 1M context window - description"
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

      // Build ID matching Claude CLI values: "opus", "sonnet", "haiku", "opus[1m]", etc.
      const versionParts = version.split('.');
      const shortId = family.toLowerCase() + '-' + versionParts.join('-') + (is1M ? '-1m' : '');

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
  // Fallback: use `which`
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
// Gemini: read model definitions from the installed npm package
// ---------------------------------------------------------------------------

/**
 * Read model list from the Gemini CLI's installed `models.js` source file.
 * Also checks ~/.gemini/settings.json for previewFeatures to include
 * preview models when enabled.
 */
async function readGeminiModels(): Promise<ModelOption[]> {
  try {
    const modelsJsPath = await findGeminiModelsJs();
    if (!modelsJsPath) return [];

    const source = await readFile(modelsJsPath, 'utf-8');

    // Extract model constants: export const SOME_NAME = 'gemini-xxx';
    const modelRegex =
      /export\s+const\s+(\w+)\s*=\s*'((?:gemini-[\w.-]+|auto|pro|flash|flash-lite))'/g;
    const constants: Record<string, string> = {};
    let m: RegExpExecArray | null;
    while ((m = modelRegex.exec(source)) !== null) {
      constants[m[1]] = m[2];
    }

    const previewEnabled = await isGeminiPreviewEnabled();
    const models: ModelOption[] = [];

    // Primary model (pro)
    const proModel = previewEnabled
      ? constants['PREVIEW_GEMINI_MODEL']
      : constants['DEFAULT_GEMINI_MODEL'];
    if (proModel) {
      models.push({
        id: proModel,
        label: formatGeminiLabel(proModel),
        description: previewEnabled ? 'Pro · preview' : 'Pro · default',
      });
    }

    // Flash model
    const flashModel = constants['DEFAULT_GEMINI_FLASH_MODEL'];
    if (flashModel) {
      models.push({
        id: flashModel,
        label: formatGeminiLabel(flashModel),
        description: 'Flash · fast',
      });
    }

    // Flash Lite model
    const flashLiteModel = constants['DEFAULT_GEMINI_FLASH_LITE_MODEL'];
    if (flashLiteModel) {
      models.push({
        id: flashLiteModel,
        label: formatGeminiLabel(flashLiteModel),
        description: 'Flash Lite · cheapest',
      });
    }

    // If preview is enabled and there's a stable pro version too, add it
    if (
      previewEnabled &&
      constants['DEFAULT_GEMINI_MODEL'] &&
      proModel !== constants['DEFAULT_GEMINI_MODEL']
    ) {
      models.push({
        id: constants['DEFAULT_GEMINI_MODEL'],
        label: formatGeminiLabel(constants['DEFAULT_GEMINI_MODEL']),
        description: 'Pro · stable',
      });
    }

    // Auto alias
    models.push({ id: 'auto', label: 'Auto', description: 'Automatic model selection' });

    return models;
  } catch {
    return [];
  }
}

function formatGeminiLabel(modelId: string): string {
  // "gemini-2.5-pro" → "Gemini 2.5 Pro"
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
      // realBin is e.g. /usr/lib/node_modules/@google/gemini-cli/dist/index.js
      // package root is two levels up from dist/index.js
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
