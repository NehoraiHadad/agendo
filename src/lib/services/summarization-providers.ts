/**
 * summarization-providers.ts
 *
 * Pluggable LLM providers for conversation summarization during agent switching.
 * All providers use CLIs with OAuth billing — no API keys needed.
 *
 * Each provider targets a fast/cheap model by default (Flash, Haiku, o4-mini)
 * since summarization is a lightweight task. If the fast model isn't available
 * for the user's account, falls back to the CLI default.
 *
 * Supported providers:
 *   - gemini  — Gemini Flash via `gemini` CLI
 *   - claude  — Claude Haiku via `claude` CLI (-p mode)
 *   - codex   — Codex via `codex exec` (o4-mini or CLI default)
 *   - auto    — tries providers in order based on CLI availability
 *
 * Override model: set SUMMARIZATION_MODEL env var (e.g. "gemini-2.5-flash",
 * "haiku", "o4-mini"). Applies to whichever provider is selected.
 */

import { collectCliOutput } from '@/lib/utils/cli-runner';
import { runGeminiPrompt } from '@/lib/gemini/headless';
import { getErrorMessage } from '@/lib/utils/error-utils';

// ============================================================================
// Types
// ============================================================================

export type SummarizationProviderName = 'gemini' | 'claude' | 'codex' | 'auto';

export interface SummarizationResult {
  text: string;
  provider: SummarizationProviderName;
  model: string;
}

// ============================================================================
// Shared prompt
// ============================================================================

const SUMMARIZATION_PROMPT = `You are a conversation summarizer for an AI coding agent handoff.
Summarize the following conversation turns into a concise context briefing (~500 tokens).

Focus on:
- Key decisions made during the conversation
- Files modified and their current state
- Current state of the work (what's done, what's pending)
- Any blockers, errors, or next steps
- Important context the new agent needs to continue effectively

Format the summary as a structured briefing with clear sections. Be specific about file paths, function names, and technical details. Do NOT include pleasantries or meta-commentary.

Conversation turns:
`;

// ============================================================================
// Fast model defaults — smallest/cheapest per provider
// ============================================================================

const FAST_DEFAULTS: Record<Exclude<SummarizationProviderName, 'auto'>, string> = {
  gemini: 'gemini-2.5-flash',
  claude: 'haiku',
  codex: 'o4-mini',
};

function getModel(provider: Exclude<SummarizationProviderName, 'auto'>): string {
  return process.env['SUMMARIZATION_MODEL'] || FAST_DEFAULTS[provider];
}

// ============================================================================
// Shared helper: run CLI and collect stdout
// ============================================================================

function runCli(command: string, args: string[], timeoutMs: number): Promise<string> {
  return collectCliOutput({ command, args, cwd: '/tmp', timeoutMs });
}

// ============================================================================
// Provider: Gemini CLI
// ============================================================================

async function summarizeWithGemini(turnText: string): Promise<SummarizationResult> {
  const model = getModel('gemini');
  const result = await runGeminiPrompt({
    prompt: SUMMARIZATION_PROMPT + turnText,
    model,
    timeoutMs: 30_000,
  });
  return { text: result.text.trim(), provider: 'gemini', model };
}

// ============================================================================
// Provider: Claude CLI (-p mode)
// ============================================================================

async function summarizeWithClaude(turnText: string): Promise<SummarizationResult> {
  const model = getModel('claude');
  const prompt = SUMMARIZATION_PROMPT + turnText;
  const text = await runCli(
    'claude',
    [
      '-p',
      prompt,
      '--model',
      model,
      '--max-turns',
      '1',
      '--no-session-persistence',
      '--permission-mode',
      'plan',
    ],
    30_000,
  );
  return { text: text.trim(), provider: 'claude', model };
}

// ============================================================================
// Provider: Codex CLI (exec mode)
// ============================================================================

async function summarizeWithCodex(turnText: string): Promise<SummarizationResult> {
  const model = getModel('codex');
  const prompt = SUMMARIZATION_PROMPT + turnText;

  // Try with the fast model first; fall back to CLI default if unsupported
  try {
    const text = await runCli(
      'codex',
      ['exec', prompt, '-m', model, '--sandbox', 'read-only'],
      30_000,
    );
    return { text: text.trim(), provider: 'codex', model };
  } catch (err) {
    const msg = getErrorMessage(err);
    // "model is not supported" → retry without -m flag (CLI default)
    if (msg.includes('not supported')) {
      const text = await runCli('codex', ['exec', prompt, '--sandbox', 'read-only'], 30_000);
      return { text: text.trim(), provider: 'codex', model: 'default' };
    }
    throw err;
  }
}

// ============================================================================
// CLI availability check (cached)
// ============================================================================

const cliAvailableCache = new Map<string, boolean>();

async function isCliAvailable(command: string): Promise<boolean> {
  const cached = cliAvailableCache.get(command);
  if (cached !== undefined) return cached;

  try {
    await runCli('which', [command], 5_000);
    cliAvailableCache.set(command, true);
    return true;
  } catch {
    cliAvailableCache.set(command, false);
    return false;
  }
}

// ============================================================================
// Provider resolution
// ============================================================================

/** Auto-detection order: cheapest/fastest first */
const AUTO_ORDER: Exclude<SummarizationProviderName, 'auto'>[] = ['gemini', 'codex', 'claude'];

async function resolveProvider(
  requested: SummarizationProviderName,
): Promise<Exclude<SummarizationProviderName, 'auto'> | null> {
  if (requested !== 'auto') {
    return (await isCliAvailable(requested)) ? requested : null;
  }
  for (const provider of AUTO_ORDER) {
    if (await isCliAvailable(provider)) return provider;
  }
  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Read the configured provider from env. Defaults to 'auto'.
 */
export function getConfiguredProvider(): SummarizationProviderName {
  const env = process.env['SUMMARIZATION_PROVIDER']?.toLowerCase();
  const valid: SummarizationProviderName[] = ['gemini', 'claude', 'codex', 'auto'];
  if (env && valid.includes(env as SummarizationProviderName)) {
    return env as SummarizationProviderName;
  }
  return 'auto';
}

/**
 * Summarize conversation turns using the configured (or specified) provider.
 * Returns null if no provider CLI is available.
 */
export async function callSummarizationProvider(
  turnText: string,
  provider?: SummarizationProviderName,
): Promise<SummarizationResult | null> {
  const requested = provider ?? getConfiguredProvider();
  const resolved = await resolveProvider(requested);
  if (!resolved) return null;

  switch (resolved) {
    case 'gemini':
      return summarizeWithGemini(turnText);
    case 'claude':
      return summarizeWithClaude(turnText);
    case 'codex':
      return summarizeWithCodex(turnText);
    default:
      return null;
  }
}
