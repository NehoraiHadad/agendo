import type { FallbackTriggerError } from '@/lib/fallback/policy';

export interface ClassifiedSessionError {
  category: FallbackTriggerError;
  summary: string;
  rawMessage: string;
}

const MATCHERS: Array<{
  category: FallbackTriggerError;
  summary: string;
  patterns: RegExp[];
}> = [
  {
    category: 'usage_limit',
    summary: 'Usage limit reached',
    patterns: [
      /usagelimitexceeded/i,
      /usage limit/i,
      /quota exceeded/i,
      /over quota/i,
      /hit your usage limit/i,
    ],
  },
  {
    category: 'auth_error',
    summary: 'Authentication failed',
    patterns: [
      /auth/i,
      /authentication/i,
      /unauthorized/i,
      /forbidden/i,
      /api key/i,
      /invalid_api_key/i,
      /token expired/i,
      /login required/i,
      /not logged in/i,
    ],
  },
  {
    category: 'rate_limited',
    summary: 'Provider rate limited the request',
    patterns: [/rate limit/i, /too many requests/i, /\b429\b/],
  },
  {
    category: 'model_unavailable',
    summary: 'Requested model is unavailable',
    patterns: [
      /model unavailable/i,
      /unknown model/i,
      /unsupported model/i,
      /model not found/i,
      /no such model/i,
    ],
  },
  {
    category: 'provider_unavailable',
    summary: 'Provider is unavailable',
    patterns: [
      /provider unavailable/i,
      /service unavailable/i,
      /upstream unavailable/i,
      /connection refused/i,
      /failed to reach provider/i,
      /\b503\b/,
    ],
  },
];

export function classifySessionError(
  error: string | null | undefined,
): ClassifiedSessionError | null {
  const rawMessage = error?.trim();
  if (!rawMessage) {
    return null;
  }

  for (const matcher of MATCHERS) {
    if (matcher.patterns.some((pattern) => pattern.test(rawMessage))) {
      return {
        category: matcher.category,
        summary: matcher.summary,
        rawMessage,
      };
    }
  }

  return null;
}
