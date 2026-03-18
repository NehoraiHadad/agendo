/**
 * Lightweight single AI API call service.
 *
 * Discovers available credentials — first from local CLI credential files
 * (e.g. ~/.claude/.credentials.json, ~/.codex/auth.json, ~/.gemini/oauth_creds.json),
 * then from env var API keys as fallback.
 *
 * No pg-boss, no CLI subprocess, no session overhead.
 * Priority order: Anthropic -> OpenAI -> Gemini (with fallback on failure).
 */

import { createLogger } from '@/lib/logger';
import { readClaudeOAuthToken, readCodexToken, readGeminiOAuthToken } from './credential-reader';
import { getAiProviderPreference } from './settings-service';

const log = createLogger('ai-call');

export type AiProvider = 'anthropic' | 'openai' | 'gemini';
type AuthMethod = 'oauth' | 'api-key';

export interface AiCallOptions {
  prompt: string;
  preferredProvider?: AiProvider;
  maxTokens?: number;
}

export interface AiCallResult {
  text: string;
  provider: AiProvider;
  model: string;
  tokens: { input: number; output: number };
}

interface ResolvedCredential {
  provider: AiProvider;
  authMethod: AuthMethod;
  /** For api-key: the raw key. For oauth: the Bearer token. */
  secret: string;
}

const DEFAULT_MAX_TOKENS = 256;

// ─── Credential resolution ─────────────────────────────────────

function resolveCredential(provider: AiProvider): ResolvedCredential | null {
  switch (provider) {
    case 'anthropic': {
      // 1. Try local OAuth credentials (Claude CLI login)
      const oauthToken = readClaudeOAuthToken();
      if (oauthToken) {
        return { provider, authMethod: 'oauth', secret: oauthToken };
      }
      // 2. Fall back to env API key
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        return { provider, authMethod: 'api-key', secret: apiKey };
      }
      return null;
    }
    case 'openai': {
      // 1. Try Codex CLI credentials
      const codexToken = readCodexToken();
      if (codexToken) {
        return { provider, authMethod: 'oauth', secret: codexToken };
      }
      // 2. Fall back to env API key
      const apiKey = process.env.OPENAI_API_KEY;
      if (apiKey) {
        return { provider, authMethod: 'api-key', secret: apiKey };
      }
      return null;
    }
    case 'gemini': {
      // 1. Try Gemini CLI OAuth credentials
      const oauthToken = readGeminiOAuthToken();
      if (oauthToken) {
        return { provider, authMethod: 'oauth', secret: oauthToken };
      }
      // 2. Fall back to env API key
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (apiKey) {
        return { provider, authMethod: 'api-key', secret: apiKey };
      }
      return null;
    }
  }
}

/** Return list of available providers in priority order. */
export function getAvailableProviders(): AiProvider[] {
  const providers: AiProvider[] = [];

  if (resolveCredential('anthropic')) providers.push('anthropic');
  if (resolveCredential('openai')) providers.push('openai');
  if (resolveCredential('gemini')) providers.push('gemini');

  return providers;
}

// ─── Provider API calls ────────────────────────────────────────

async function callAnthropic(
  cred: ResolvedCredential,
  prompt: string,
  maxTokens: number,
): Promise<AiCallResult> {
  const headers: Record<string, string> =
    cred.authMethod === 'oauth'
      ? {
          'content-type': 'application/json',
          authorization: `Bearer ${cred.secret}`,
          'anthropic-version': '2023-06-01',
        }
      : {
          'content-type': 'application/json',
          'x-api-key': cred.secret,
          'anthropic-version': '2023-06-01',
        };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  };

  const text = data.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  return {
    text,
    provider: 'anthropic',
    model: data.model,
    tokens: { input: data.usage.input_tokens, output: data.usage.output_tokens },
  };
}

async function callOpenAI(
  cred: ResolvedCredential,
  prompt: string,
  maxTokens: number,
): Promise<AiCallResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cred.secret}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    model: string;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text: data.choices[0]?.message?.content ?? '',
    provider: 'openai',
    model: data.model,
    tokens: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens },
  };
}

async function callGemini(
  cred: ResolvedCredential,
  prompt: string,
  maxTokens: number,
): Promise<AiCallResult> {
  const model = 'gemini-2.0-flash';

  // OAuth uses Authorization header; API key uses query param
  const url =
    cred.authMethod === 'api-key'
      ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cred.secret}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cred.authMethod === 'oauth') {
    headers['authorization'] = `Bearer ${cred.secret}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    modelVersion?: string;
    usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
  };

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';

  return {
    text,
    provider: 'gemini',
    model: data.modelVersion ?? model,
    tokens: {
      input: data.usageMetadata?.promptTokenCount ?? 0,
      output: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

// ─── Main entry point ──────────────────────────────────────────

/**
 * Make a single AI API call with automatic provider fallback.
 *
 * Credential resolution per provider:
 *   1. Local CLI credentials (OAuth tokens from ~/.claude, ~/.codex, ~/.gemini)
 *   2. Env var API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)
 *
 * Tries providers in priority order (Anthropic > OpenAI > Gemini),
 * falling back to the next on failure.
 */
export async function aiCall(opts: AiCallOptions): Promise<AiCallResult> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const available = getAvailableProviders();

  if (available.length === 0) {
    throw new Error('No AI provider credentials found (checked CLI credentials and env API keys)');
  }

  // Determine effective preferred provider:
  // 1. Explicit per-call preference takes highest priority
  // 2. Persisted system-wide preference from settings
  // 3. Default priority order (Anthropic > OpenAI > Gemini)
  const systemPreference = getAiProviderPreference();
  const effectivePreferred =
    opts.preferredProvider ?? (systemPreference !== 'auto' ? systemPreference : undefined);

  const ordered =
    effectivePreferred && available.includes(effectivePreferred)
      ? [effectivePreferred, ...available.filter((p) => p !== effectivePreferred)]
      : [...available];

  const errors: Error[] = [];

  for (const provider of ordered) {
    const cred = resolveCredential(provider);
    if (!cred) continue;

    try {
      switch (cred.provider) {
        case 'anthropic':
          return await callAnthropic(cred, opts.prompt, maxTokens);
        case 'openai':
          return await callOpenAI(cred, opts.prompt, maxTokens);
        case 'gemini':
          return await callGemini(cred, opts.prompt, maxTokens);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn(
        { provider, authMethod: cred.authMethod, err: error.message },
        'AI provider call failed, trying next',
      );
      errors.push(error);
    }
  }

  throw new Error(`All AI providers failed: ${errors.map((e) => e.message).join('; ')}`);
}
