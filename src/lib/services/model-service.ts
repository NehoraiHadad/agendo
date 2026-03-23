import { readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  /** Whether this model is the CLI's default when no --model flag is passed. */
  isDefault?: boolean;
}

export type Provider = 'anthropic' | 'openai' | 'google' | 'github';

// ---------------------------------------------------------------------------
// In-memory cache (1 hour TTL)
// ---------------------------------------------------------------------------

/** Cache TTL — short to avoid showing stale models after CLI upgrades.
 *  Model discovery spawns a child process (~1-5s) so some caching is needed
 *  to keep the UI snappy, but 5 minutes is short enough that a CLI upgrade
 *  or new model release is reflected quickly. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  models: ModelOption[];
  fetchedAt: number;
}
const cache = new Map<Provider, CacheEntry>();

function getCached(provider: Provider, skipCache?: boolean): ModelOption[] | null {
  if (skipCache) return null;
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

/** Get the cache timestamp for a provider (for API transparency). */
export function getCacheAge(provider: Provider): number | null {
  const entry = cache.get(provider);
  return entry ? Date.now() - entry.fetchedAt : null;
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

/** Spawn a process, collect stdout, with optional env override. Uses spawn (no shell). */
function safeSpawnCollect(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: Record<string, string | undefined>; cwd?: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    const timeout = opts.timeout ?? 15000;

    const proc = cp.spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env as NodeJS.ProcessEnv,
      cwd: opts.cwd,
    });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`safeSpawnCollect timeout after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code}: ${stderr.slice(0, 1000)}`));
      } else {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      }
    });
    proc.on('error', (spawnErr: Error) => {
      clearTimeout(timer);
      reject(spawnErr);
    });
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
              isDefault: m.isDefault ?? false,
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
// Claude: query models via the @anthropic-ai/claude-agent-sdk
// ---------------------------------------------------------------------------

/**
 * Query Claude models via the SDK's `supportedModels()` in a child Node process.
 *
 * Why a child process?
 * The SDK's `query()` fails inside Next.js Turbopack with "Query closed before
 * response received" — Turbopack's module evaluation interferes with the SDK's
 * async lifecycle. Running `scripts/list-claude-models.mjs` as a standalone Node
 * process bypasses Turbopack entirely and uses normal Node ESM resolution.
 *
 * Why strip CLAUDECODE?
 * The Claude CLI checks `process.env.CLAUDECODE === "1"` at startup and refuses
 * to launch ("cannot launch inside another Claude Code session"). This var leaks
 * into PM2-managed processes when `pm2 start` is run from a Claude Code session.
 */
/** Shape of SDK supportedModels() entries */
interface ClaudeSdkModel {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

async function readClaudeModelsViaSdk(): Promise<ModelOption[]> {
  const scriptPath = join(process.cwd(), 'scripts', 'list-claude-models.mjs');

  // Strip vars that interfere with the child process:
  // - CLAUDECODE/CLAUDE_CODE_ENTRYPOINT: CLI refuses to start ("nested session")
  // - NODE_CHANNEL_FD/NODE_CHANNEL_SERIALIZATION_MODE: PM2 IPC channel leaks
  // - NODE_OPTIONS: parent memory limits shouldn't constrain the child
  const stripKeys = new Set([
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'NODE_CHANNEL_FD',
    'NODE_CHANNEL_SERIALIZATION_MODE',
    'NODE_OPTIONS',
  ]);
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !stripKeys.has(k)),
  );

  const stdout = await safeSpawnCollect('node', [scriptPath], {
    timeout: 15000,
    env: cleanEnv,
  });

  const models = JSON.parse(stdout.trim()) as ClaudeSdkModel[];

  // Pass through as-is from the SDK — no manipulation
  return models.map((m) => ({
    id: m.value,
    label: m.displayName,
    description: m.description,
    isDefault: m.value === 'default',
  }));
}

/**
 * Read Claude models. Prefers SDK supportedModels() (the canonical picker list
 * that matches what Claude's own `/model` command shows). Falls back to
 * binary extraction only if the SDK fails entirely.
 *
 * The SDK returns exactly the models a user would want to pick — no aliases,
 * no legacy versions, no noise. The legacy fallback applies similar filtering.
 */
async function readClaudeModels(): Promise<ModelOption[]> {
  try {
    const sdkModels = await readClaudeModelsViaSdk();
    if (sdkModels.length > 0) return sdkModels;
  } catch (err) {
    console.error('[model-service] SDK readClaudeModelsViaSdk failed:', (err as Error).message);
  }
  // No legacy fallback — the SDK is the authoritative source.
  // The old `strings` binary extraction was brittle and could return
  // stale model IDs that no longer match the API. Empty is better.
  return [];
}

// ---------------------------------------------------------------------------
// Gemini: load models.js module from @google/gemini-cli-core via createRequire
// ---------------------------------------------------------------------------

/** Shape of the models.js module exports from @google/gemini-cli-core */
interface GeminiModelsModule {
  // Concrete model constants
  DEFAULT_GEMINI_MODEL?: string;
  DEFAULT_GEMINI_FLASH_MODEL?: string;
  DEFAULT_GEMINI_FLASH_LITE_MODEL?: string;
  PREVIEW_GEMINI_MODEL?: string;
  PREVIEW_GEMINI_3_1_MODEL?: string;
  PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL?: string;
  PREVIEW_GEMINI_FLASH_MODEL?: string;
  PREVIEW_GEMINI_3_1_FLASH_LITE_MODEL?: string;
  // Auto model constants
  PREVIEW_GEMINI_MODEL_AUTO?: string;
  DEFAULT_GEMINI_MODEL_AUTO?: string;
  // Alias constants
  GEMINI_MODEL_ALIAS_AUTO?: string;
  GEMINI_MODEL_ALIAS_PRO?: string;
  GEMINI_MODEL_ALIAS_FLASH?: string;
  GEMINI_MODEL_ALIAS_FLASH_LITE?: string;
  // Model set
  VALID_GEMINI_MODELS?: Set<string>;
  // Functions
  getDisplayString?: (model: string) => string;
  isPreviewModel?: (model: string) => boolean;
  isActiveModel?: (model: string, useGemini3_1?: boolean, useCustomToolModel?: boolean) => boolean;
  isAutoModel?: (model: string) => boolean;
  resolveModel?: (
    model: string,
    useGemini3_1?: boolean,
    useCustomToolModel?: boolean,
    hasAccessToPreview?: boolean,
  ) => string;
}

/**
 * Read model list from Gemini CLI's installed `models.js` module.
 *
 * No official `gemini --list-models` command or ACP `model/list` method exists
 * (verified against Gemini CLI v0.31.0 and @agentclientprotocol/sdk).
 *
 * Primary: createRequire() to load the module at runtime, accessing
 * VALID_GEMINI_MODELS set, getDisplayString(), isPreviewModel(), etc.
 * This is invisible to Turbopack (no static import) and automatically
 * picks up new models added to the set without code changes.
 *
 * Fallback: regex parsing of `export const` statements (in case the
 * module format changes to ESM or the exports are restructured).
 */
async function readGeminiModels(): Promise<ModelOption[]> {
  try {
    const modelsJsPath = await findGeminiModelsJs();
    if (!modelsJsPath) return [];

    try {
      return await readGeminiModelsViaRequire(modelsJsPath);
    } catch {
      // createRequire failed (e.g. module format changed), fall back to regex
      return await readGeminiModelsViaRegex(modelsJsPath);
    }
  } catch {
    return [];
  }
}

/**
 * Primary approach: load models.js via createRequire() and use its exported
 * constants and functions directly. This automatically picks up new models
 * added to VALID_GEMINI_MODELS without needing code changes.
 *
 * Strategy:
 * 1. Iterate VALID_GEMINI_MODELS, filter via isActiveModel() — shows only
 *    models the CLI considers usable for the current config.
 * 2. Add the two auto entries (preview + stable) with labels from getDisplayString().
 * 3. Skip shorthand aliases (auto, pro, flash, flash-lite) — they resolve to
 *    concrete models already listed.
 */
async function readGeminiModelsViaRequire(modelsJsPath: string): Promise<ModelOption[]> {
  const req = createRequire(modelsJsPath);
  const mod = req(modelsJsPath) as GeminiModelsModule;

  if (!mod.VALID_GEMINI_MODELS) return [];

  const previewEnabled = await isGeminiPreviewEnabled();
  const models: ModelOption[] = [];
  const seen = new Set<string>();

  // Collect the alias values to skip them when iterating VALID_GEMINI_MODELS
  const aliasValues = new Set<string | undefined>([
    mod.GEMINI_MODEL_ALIAS_AUTO,
    mod.GEMINI_MODEL_ALIAS_PRO,
    mod.GEMINI_MODEL_ALIAS_FLASH,
    mod.GEMINI_MODEL_ALIAS_FLASH_LITE,
  ]);

  // 1. Auto entries first (these are not in VALID_GEMINI_MODELS but are valid picks)
  if (mod.PREVIEW_GEMINI_MODEL_AUTO) {
    const id = mod.PREVIEW_GEMINI_MODEL_AUTO;
    const label = mod.getDisplayString ? mod.getDisplayString(id) : formatGeminiLabel(id);
    models.push({
      id,
      label,
      description: 'Automatic model selection (Gemini 3)',
      isDefault: previewEnabled,
    });
    seen.add(id);
  }
  if (mod.DEFAULT_GEMINI_MODEL_AUTO) {
    const id = mod.DEFAULT_GEMINI_MODEL_AUTO;
    const label = mod.getDisplayString ? mod.getDisplayString(id) : formatGeminiLabel(id);
    models.push({
      id,
      label,
      description: 'Automatic model selection (Gemini 2.5)',
      isDefault: !previewEnabled,
    });
    seen.add(id);
  }

  // 2. Concrete models from VALID_GEMINI_MODELS, filtered by isActiveModel()
  for (const modelId of mod.VALID_GEMINI_MODELS) {
    if (seen.has(modelId)) continue;
    // Skip shorthand aliases — they resolve to concrete models already listed
    if (aliasValues.has(modelId)) continue;
    // Use isActiveModel() to determine if this model is usable
    if (mod.isActiveModel && !mod.isActiveModel(modelId)) continue;
    // Use isPreviewModel to generate description
    const isPreview = mod.isPreviewModel ? mod.isPreviewModel(modelId) : false;
    models.push({
      id: modelId,
      label: formatGeminiLabel(modelId),
      description: isPreview ? 'Preview' : 'Stable',
    });
    seen.add(modelId);
  }

  return models;
}

/**
 * Fallback: parse exported string constants from models.js via regex.
 * Used if createRequire() fails (e.g. module format changes to ESM).
 */
async function readGeminiModelsViaRegex(modelsJsPath: string): Promise<ModelOption[]> {
  const code = await readFile(modelsJsPath, 'utf-8');
  const m: Record<string, string> = {};
  for (const match of code.matchAll(/export\s+const\s+(\w+)\s*=\s*['"]([^'"]+)['"]/g)) {
    m[match[1]] = match[2];
  }

  const previewEnabled = await isGeminiPreviewEnabled();
  const models: ModelOption[] = [];

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

  const flashModel = m['DEFAULT_GEMINI_FLASH_MODEL'] as string | undefined;
  if (flashModel) {
    models.push({
      id: flashModel,
      label: formatGeminiLabel(flashModel),
      description: 'Flash - fast',
    });
  }

  const flashLiteModel = m['DEFAULT_GEMINI_FLASH_LITE_MODEL'] as string | undefined;
  if (flashLiteModel) {
    models.push({
      id: flashLiteModel,
      label: formatGeminiLabel(flashLiteModel),
      description: 'Flash Lite - cheapest',
    });
  }

  const stablePro = m['DEFAULT_GEMINI_MODEL'] as string | undefined;
  if (previewEnabled && stablePro && proModel !== stablePro) {
    models.push({
      id: stablePro,
      label: formatGeminiLabel(stablePro),
      description: 'Pro - stable',
    });
  }

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
}

/**
 * Format a Gemini model ID into a user-friendly label.
 *
 * Rules:
 * - Strip `-preview` suffix (preview status shown via description badge)
 * - Strip `-customtools` suffix (internal variant, not user-facing)
 * - Capitalize "gemini" → "Gemini"
 * - Keep version numbers as-is (e.g. "2.5", "3.1")
 * - Capitalize tier words (Pro, Flash, Lite)
 *
 * Examples:
 *   "gemini-3-pro-preview"          → "Gemini 3 Pro"
 *   "gemini-3.1-pro-preview"        → "Gemini 3.1 Pro"
 *   "gemini-2.5-pro"                → "Gemini 2.5 Pro"
 *   "gemini-3-flash-preview"        → "Gemini 3 Flash"
 *   "gemini-2.5-flash"              → "Gemini 2.5 Flash"
 *   "gemini-2.5-flash-lite"         → "Gemini 2.5 Flash Lite"
 *   "gemini-3.1-flash-lite-preview" → "Gemini 3.1 Flash Lite"
 *   "auto"                          → "Auto"
 */
function formatGeminiLabel(modelId: string): string {
  // Strip suffixes that aren't user-facing
  let cleaned = modelId.replace(/-preview$/, '').replace(/-customtools$/, '');
  // Also strip the combined variant suffix
  cleaned = cleaned.replace(/-preview-customtools$/, '');

  return cleaned
    .split('-')
    .map((part) => {
      if (part === 'gemini') return 'Gemini';
      // Version numbers stay as-is
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
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
// Copilot: parse model choices from `copilot --help` output
// ---------------------------------------------------------------------------

/**
 * Read Copilot CLI model list by parsing `copilot --help` output.
 *
 * The `--model` flag's `(choices: ...)` list is the authoritative source.
 * Copilot supports models from multiple providers (Claude, GPT, Gemini).
 * Falls back to a hardcoded list if the CLI is unavailable.
 */
async function readCopilotModels(): Promise<ModelOption[]> {
  try {
    return await readCopilotModelsFromHelp();
  } catch {
    // No hardcoded fallback — return empty rather than stale model IDs.
    // The CLI is the only source of truth for available models.
    return [];
  }
}

/** Parse model choices from `copilot --help` output. */
async function readCopilotModelsFromHelp(): Promise<ModelOption[]> {
  const stdout = await safeExecFile('copilot', ['--help'], {
    timeout: 10000,
    maxBuffer: 1024 * 512,
  });

  // Extract the choices list from --model flag help text.
  // Format: --model <model>  Set the AI model to use (choices: "model1", "model2", ...)
  const choicesMatch = stdout.match(/--model\s+<model>[\s\S]*?\(choices:\s*((?:"[^"]+",?\s*)+)\)/);
  if (!choicesMatch) throw new Error('No --model choices found in copilot --help');

  const choicesStr = choicesMatch[1];
  const modelIds: string[] = [];
  for (const m of choicesStr.matchAll(/"([^"]+)"/g)) {
    modelIds.push(m[1]);
  }

  if (modelIds.length === 0) throw new Error('Empty --model choices in copilot --help');

  return modelIds.map((id) => ({
    id,
    label: formatCopilotLabel(id),
    description: describeCopilotModel(id),
  }));
}

/** Format a copilot model ID into a human-readable label. */
function formatCopilotLabel(modelId: string): string {
  // Examples: "gpt-5.4" → "GPT 5.4", "claude-opus-4.6" → "Claude Opus 4.6",
  // "gemini-3-pro-preview" → "Gemini 3 Pro Preview"
  return modelId
    .split('-')
    .map((part) => {
      if (part === 'gpt') return 'GPT';
      if (part === 'claude') return 'Claude';
      if (part === 'gemini') return 'Gemini';
      // Version numbers stay as-is
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

/** Generate a brief description based on the model ID. */
function describeCopilotModel(modelId: string): string {
  if (modelId.includes('claude-opus')) return 'Anthropic Opus';
  if (modelId.includes('claude-sonnet')) return 'Anthropic Sonnet';
  if (modelId.includes('claude-haiku')) return 'Anthropic Haiku';
  if (modelId.includes('gemini')) return 'Google Gemini';
  if (modelId.includes('codex-max')) return 'OpenAI Codex Max';
  if (modelId.includes('codex-mini')) return 'OpenAI Codex Mini';
  if (modelId.includes('codex')) return 'OpenAI Codex';
  if (modelId.includes('mini')) return 'OpenAI Mini';
  if (modelId.startsWith('gpt-')) return 'OpenAI GPT';
  return modelId;
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
    // Return 'auto' — the CLI resolves it to the right concrete model
    // based on the user's previewFeatures setting.
    return 'auto';
  }
  return models[0].id;
}

/** Get models for a given provider by reading from the CLI tool's local data.
 *  Pass `skipCache: true` to force a fresh query (e.g. user clicked refresh). */
export async function getModelsForProvider(
  provider: Provider,
  opts?: { skipCache?: boolean },
): Promise<ModelOption[]> {
  const cached = getCached(provider, opts?.skipCache);
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
    case 'github':
      models = await readCopilotModels();
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
  if (lower === 'copilot' || lower === 'github') return 'github';
  return null;
}
