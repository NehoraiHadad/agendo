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
  return readClaudeModelsLegacy();
}

/**
 * Legacy fallback: extract model picker entries from the Claude CLI binary.
 *
 * Parses the same picker labels that Claude's own `/model` command shows:
 *   "Opus 4.6 - most capable for complex work"
 *   "Sonnet 4.6 with 1M context window - for long sessions with large codebases"
 *
 * This gives us exactly the models a user would see in the Claude picker —
 * no aliases (claude-opus-4), no legacy versions (claude-opus-4-0), no noise.
 */
async function readClaudeModelsLegacy(): Promise<ModelOption[]> {
  try {
    const binaryPath = await resolveClaudeBinary();
    if (!binaryPath) return [];

    // Extract picker label lines: "Family X.Y - description" and "Family X.Y with 1M context window - description"
    const stdout = await safePipe(
      'strings',
      [binaryPath],
      'grep',
      ['-P', '^(Opus|Sonnet|Haiku) [\\d.]+(?: with 1M context window)? - '],
      { timeout: 15000 },
    );

    const pickerRe = /^(Opus|Sonnet|Haiku) ([\d.]+)(?: with 1M context window)? - (.+)$/gm;
    const models: ModelOption[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = pickerRe.exec(stdout)) !== null) {
      const fullLine = match[0];
      const family = match[1];
      const version = match[2];
      const description = match[3].trim();
      const is1M = fullLine.includes('with 1M context window');

      const vParts = version.split('.');
      const id = 'claude-' + family.toLowerCase() + '-' + vParts.join('-') + (is1M ? '[1m]' : '');

      if (seen.has(id)) continue;
      seen.add(id);

      models.push({
        id,
        label: `${family} ${version}${is1M ? ' (1M)' : ''}`,
        description,
      });
    }

    // Sort: opus first, then sonnet, then haiku. Within family: highest version first, 1M after base.
    models.sort((a, b) => {
      const fa = a.id.includes('opus') ? 0 : a.id.includes('sonnet') ? 1 : 2;
      const fb = b.id.includes('opus') ? 0 : b.id.includes('sonnet') ? 1 : 2;
      if (fa !== fb) return fa - fb;
      const baseA = a.id.replace('[1m]', '');
      const baseB = b.id.replace('[1m]', '');
      if (baseA !== baseB) return baseB.localeCompare(baseA);
      return (a.id.includes('[1m]') ? 1 : 0) - (b.id.includes('[1m]') ? 1 : 0);
    });

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
// Gemini: load models.js module from @google/gemini-cli-core via createRequire
// ---------------------------------------------------------------------------

/** Shape of the models.js module exports from @google/gemini-cli-core */
interface GeminiModelsModule {
  DEFAULT_GEMINI_MODEL?: string;
  DEFAULT_GEMINI_FLASH_MODEL?: string;
  DEFAULT_GEMINI_FLASH_LITE_MODEL?: string;
  PREVIEW_GEMINI_MODEL?: string;
  PREVIEW_GEMINI_3_1_MODEL?: string;
  PREVIEW_GEMINI_FLASH_MODEL?: string;
  PREVIEW_GEMINI_MODEL_AUTO?: string;
  DEFAULT_GEMINI_MODEL_AUTO?: string;
  GEMINI_MODEL_ALIAS_AUTO?: string;
  VALID_GEMINI_MODELS?: Set<string>;
  getDisplayString?: (model: string) => string;
  isPreviewModel?: (model: string) => boolean;
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
 */
async function readGeminiModelsViaRequire(modelsJsPath: string): Promise<ModelOption[]> {
  const req = createRequire(modelsJsPath);
  const mod = req(modelsJsPath) as GeminiModelsModule;

  const previewEnabled = await isGeminiPreviewEnabled();
  const models: ModelOption[] = [];
  const seen = new Set<string>();

  const addModel = (id: string, description: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const label = mod.getDisplayString ? mod.getDisplayString(id) : formatGeminiLabel(id);
    models.push({ id, label, description });
  };

  // 1. Primary pro model (preview or stable depending on settings)
  if (previewEnabled && mod.PREVIEW_GEMINI_MODEL) {
    addModel(mod.PREVIEW_GEMINI_MODEL, 'Pro - preview');
  }
  if (mod.DEFAULT_GEMINI_MODEL) {
    addModel(mod.DEFAULT_GEMINI_MODEL, previewEnabled ? 'Pro - stable' : 'Pro - default');
  }

  // 2. Preview 3.1 model (if preview enabled)
  if (previewEnabled && mod.PREVIEW_GEMINI_3_1_MODEL) {
    addModel(mod.PREVIEW_GEMINI_3_1_MODEL, 'Pro 3.1 - preview');
  }

  // 3. Flash models
  if (previewEnabled && mod.PREVIEW_GEMINI_FLASH_MODEL) {
    addModel(mod.PREVIEW_GEMINI_FLASH_MODEL, 'Flash - preview');
  }
  if (mod.DEFAULT_GEMINI_FLASH_MODEL) {
    addModel(mod.DEFAULT_GEMINI_FLASH_MODEL, 'Flash - fast');
  }

  // 4. Flash Lite
  if (mod.DEFAULT_GEMINI_FLASH_LITE_MODEL) {
    addModel(mod.DEFAULT_GEMINI_FLASH_LITE_MODEL, 'Flash Lite - cheapest');
  }

  // 5. Auto aliases
  if (previewEnabled && mod.PREVIEW_GEMINI_MODEL_AUTO) {
    addModel(mod.PREVIEW_GEMINI_MODEL_AUTO, 'Automatic model selection (preview)');
  }
  if (mod.DEFAULT_GEMINI_MODEL_AUTO) {
    addModel(mod.DEFAULT_GEMINI_MODEL_AUTO, 'Automatic model selection');
  }
  if (mod.GEMINI_MODEL_ALIAS_AUTO) {
    addModel(mod.GEMINI_MODEL_ALIAS_AUTO, 'Automatic model selection');
  }

  // 6. Any remaining models in VALID_GEMINI_MODELS not yet listed
  if (mod.VALID_GEMINI_MODELS) {
    for (const modelId of mod.VALID_GEMINI_MODELS) {
      if (seen.has(modelId)) continue;
      // Skip internal-only models (e.g. customtools variant)
      if (modelId.includes('customtools')) continue;
      const isPreview = mod.isPreviewModel ? mod.isPreviewModel(modelId) : false;
      if (isPreview && !previewEnabled) continue;
      addModel(modelId, isPreview ? 'Preview' : 'Stable');
    }
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
    return getCopilotModelsFallback();
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

/** Hardcoded fallback list in case the CLI is not available. */
function getCopilotModelsFallback(): ModelOption[] {
  const ids = [
    'claude-sonnet-4.6',
    'claude-opus-4.6',
    'gpt-5.4',
    'gpt-5.2',
    'gemini-3-pro-preview',
  ];
  return ids.map((id) => ({
    id,
    label: formatCopilotLabel(id),
    description: describeCopilotModel(id),
  }));
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
