/**
 * Lightweight single AI API call service.
 *
 * Discovers available provider credentials and makes a direct HTTP fetch
 * to the provider API. No pg-boss, no CLI subprocess, no session overhead.
 *
 * Priority order: Anthropic -> OpenAI -> Gemini (with fallback on failure).
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('ai-call');

export type AiProvider = 'anthropic' | 'openai' | 'gemini';

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

interface ProviderConfig {
  provider: AiProvider;
  apiKey: string;
}

const DEFAULT_MAX_TOKENS = 256;

/** Return list of available providers in priority order. */
export function getAvailableProviders(): AiProvider[] {
  const providers: AiProvider[] = [];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push('anthropic');
  }
  if (process.env.OPENAI_API_KEY) {
    providers.push('openai');
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    providers.push('gemini');
  }

  return providers;
}

function getProviderConfig(provider: AiProvider): ProviderConfig | null {
  switch (provider) {
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      return key ? { provider, apiKey: key } : null;
    }
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      return key ? { provider, apiKey: key } : null;
    }
    case 'gemini': {
      const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      return key ? { provider, apiKey: key } : null;
    }
  }
}

async function callAnthropic(
  apiKey: string,
  prompt: string,
  maxTokens: number,
): Promise<AiCallResult> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
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
  apiKey: string,
  prompt: string,
  maxTokens: number,
): Promise<AiCallResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
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
  apiKey: string,
  prompt: string,
  maxTokens: number,
): Promise<AiCallResult> {
  const model = 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

/**
 * Make a single AI API call with automatic provider fallback.
 *
 * Tries providers in priority order (Anthropic > OpenAI > Gemini),
 * falling back to the next on failure.
 */
export async function aiCall(opts: AiCallOptions): Promise<AiCallResult> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const available = getAvailableProviders();

  if (available.length === 0) {
    throw new Error('No AI provider API keys configured');
  }

  // Reorder if preferred provider is specified and available
  const ordered =
    opts.preferredProvider && available.includes(opts.preferredProvider)
      ? [opts.preferredProvider, ...available.filter((p) => p !== opts.preferredProvider)]
      : [...available];

  const errors: Error[] = [];

  for (const provider of ordered) {
    const config = getProviderConfig(provider);
    if (!config) continue;

    try {
      switch (config.provider) {
        case 'anthropic':
          return await callAnthropic(config.apiKey, opts.prompt, maxTokens);
        case 'openai':
          return await callOpenAI(config.apiKey, opts.prompt, maxTokens);
        case 'gemini':
          return await callGemini(config.apiKey, opts.prompt, maxTokens);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.warn({ provider, err: error.message }, 'AI provider call failed, trying next');
      errors.push(error);
    }
  }

  throw new Error(`All AI providers failed: ${errors.map((e) => e.message).join('; ')}`);
}
