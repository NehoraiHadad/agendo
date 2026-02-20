/**
 * ai-query-service.ts
 *
 * Reusable service for sending one-shot prompts to any registered AI agent
 * and getting back plain text. No sessions, no queues — just execFile + parse.
 *
 * Adding support for a new provider: add an entry to PROVIDER_ADAPTERS below.
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '@/lib/db';
import { agents } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiQueryOptions {
  /** The prompt to send to the AI. */
  prompt: string;
  /** Timeout in ms (default: 60s). */
  timeoutMs?: number;
  /** Prefer a specific provider slug (e.g. 'claude-code'). Falls back automatically. */
  preferredSlug?: string;
}

export interface AiQueryResult {
  /** The raw text response from the AI. */
  text: string;
  /** Human-readable provider name (e.g. 'Claude Code'). */
  providerName: string;
}

// ---------------------------------------------------------------------------
// Provider adapters
// ---------------------------------------------------------------------------

interface ProviderAdapter {
  /** Display name for logging / UI feedback. */
  displayName: string;
  /** Build the argv to pass to the binary for a one-shot prompt. */
  buildArgs(prompt: string): string[];
  /** Extract plain text from the binary's stdout. */
  extractText(stdout: string): string;
  /** Env vars to strip before spawning (to avoid nested-session guards). */
  stripEnvKeys: string[];
}

/**
 * Map from binary basename → adapter.
 * Add codex / gemini adapters here when their one-shot flags are confirmed.
 */
const PROVIDER_ADAPTERS: Record<string, ProviderAdapter> = {
  claude: {
    displayName: 'Claude Code',
    buildArgs: (prompt) => ['--model', 'haiku', '--no-session-persistence', '--output-format', 'json', '-p', prompt],
    extractText: (stdout) => {
      // --output-format json wraps response in { "result": "..." }
      try {
        const wrapper = JSON.parse(stdout.trim()) as { result?: string };
        if (typeof wrapper.result === 'string') return wrapper.result;
      } catch { /* fall through */ }
      return stdout;
    },
    stripEnvKeys: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
  },

  // Codex one-shot: `codex exec "prompt"` (non-interactive)
  // Uncomment and verify flags once confirmed:
  // codex: {
  //   displayName: 'Codex CLI',
  //   buildArgs: (prompt) => ['exec', prompt],
  //   extractText: (stdout) => stdout,
  //   stripEnvKeys: ['CODEX_SESSION_ID'],
  // },

  gemini: {
    displayName: 'Gemini CLI',
    buildArgs: (prompt) => ['-p', prompt, '--output-format', 'json'],
    extractText: (stdout) => {
      const wrapper = JSON.parse(stdout.trim()) as { response?: string; text?: string };
      if (typeof wrapper.response === 'string') return wrapper.response;
      if (typeof wrapper.text === 'string') return wrapper.text;
      throw new Error('Gemini response missing response/text field');
    },
    stripEnvKeys: [],
  },
};

// ---------------------------------------------------------------------------
// Core query function
// ---------------------------------------------------------------------------

/**
 * Send a one-shot prompt to the best available registered AI agent.
 * Tries agents in preference order; throws if none are available.
 */
export async function queryAI(opts: AiQueryOptions): Promise<AiQueryResult> {
  const { prompt, timeoutMs = 60_000, preferredSlug } = opts;

  const candidates = await findCandidates(preferredSlug);
  if (candidates.length === 0) {
    throw new Error(
      'No AI agent available for one-shot queries. Register Claude, Codex, or Gemini via Discovery.',
    );
  }

  let lastError: Error | null = null;

  for (const { binaryPath, adapter, displayName } of candidates) {
    try {
      const env = buildEnv(adapter.stripEnvKeys);
      const args = adapter.buildArgs(prompt);

      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(binaryPath, args, {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          env,
          cwd: '/tmp',
        }));
      } catch (execErr: unknown) {
        // Some CLIs (e.g. claude) exit non-zero even when stdout contains valid output.
        // Only use stdout from the error — stderr contains startup metrics / noise.
        const e = execErr as { stdout?: string; stderr?: string; message?: string; code?: number | string };
        console.error(`[queryAI] ${displayName} exit non-zero (code=${e.code})\nstdout=${(e.stdout ?? '').slice(0, 300)}\nstderr_tail=${(e.stderr ?? '').slice(-500)}`);
        const fallback = e.stdout ?? '';
        if (fallback.trim().length > 20) {
          stdout = fallback;
        } else {
          lastError = execErr instanceof Error ? execErr : new Error(String(execErr));
          continue;
        }
      }

      const text = adapter.extractText(stdout).trim();
      if (!text) throw new Error('Empty response from AI');

      return { text, providerName: displayName };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Try next candidate
    }
  }

  throw lastError ?? new Error('All AI providers failed');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Candidate {
  binaryPath: string;
  adapter: ProviderAdapter;
  displayName: string;
}

async function findCandidates(preferredSlug?: string): Promise<Candidate[]> {
  const aiAgents = await db
    .select({ binaryPath: agents.binaryPath, slug: agents.slug, name: agents.name })
    .from(agents)
    .where(eq(agents.toolType, 'ai-agent'));

  const candidates: Candidate[] = [];

  for (const agent of aiAgents) {
    const binaryName = path.basename(agent.binaryPath);
    const adapter = PROVIDER_ADAPTERS[binaryName];
    if (!adapter) continue; // no one-shot adapter for this provider yet

    candidates.push({
      binaryPath: agent.binaryPath,
      adapter,
      displayName: adapter.displayName,
    });
  }

  // Sort: preferred slug first, then stable order
  candidates.sort((a, b) => {
    if (preferredSlug) {
      const aMatch = aiAgents.find((ag) => ag.binaryPath === a.binaryPath)?.slug === preferredSlug;
      const bMatch = aiAgents.find((ag) => ag.binaryPath === b.binaryPath)?.slug === preferredSlug;
      if (aMatch && !bMatch) return -1;
      if (!aMatch && bMatch) return 1;
    }
    return 0;
  });

  // Deduplicate by binaryPath (multiple agents may share the same binary)
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.binaryPath)) return false;
    seen.add(c.binaryPath);
    return true;
  });
}

function buildEnv(stripKeys: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of stripKeys) {
    delete env[key];
  }
  return env;
}
