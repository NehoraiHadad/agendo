/**
 * Unified usage/account info service for all AI providers.
 *
 * Reads credentials from local CLI credential files (cross-platform via os.homedir())
 * and fetches whatever usage/account data each provider's API exposes.
 *
 * Provider API capabilities:
 * - Claude: Full usage data (rate limits, utilization) via /api/oauth/usage
 * - OpenAI: Account info only via /v1/me (usage/billing requires Admin API keys)
 * - Gemini: Account info only via Google userinfo (no usage API for CLI credentials)
 */

import {
  readClaudeCredentials,
  readCodexOAuthToken,
  readGeminiOAuthToken,
} from './credential-reader';
import { getErrorMessage } from '@/lib/utils/error-utils';

// ─── Types ─────────────────────────────────────────────────────

export interface UsageResult {
  provider: 'claude' | 'openai' | 'gemini';
  status: 'ok' | 'no_credentials' | 'error';
  account: Record<string, unknown> | null;
  usage: Record<string, unknown> | null;
  /** Human-readable note about limitations */
  note?: string;
  error?: string;
}

// ─── Shared fetch helper ────────────────────────────────────────

/**
 * Generic provider usage fetcher.
 *
 * Handles the common pattern for all three providers:
 * 1. Read credential — early return if missing
 * 2. Fetch URL with provider-specific headers
 * 3. Check res.ok — return error result if not
 * 4. Parse JSON — map to UsageResult fields
 * 5. Catch any error — return error result
 */
async function fetchProviderUsage<TCred, TData>(opts: {
  provider: UsageResult['provider'];
  getCredential: () => TCred | null;
  url: string;
  buildHeaders: (cred: TCred) => Record<string, string>;
  mapResult: (cred: TCred, data: TData) => Pick<UsageResult, 'account' | 'usage' | 'note'>;
}): Promise<UsageResult> {
  const { provider, getCredential, url, buildHeaders, mapResult } = opts;

  const cred = getCredential();
  if (!cred) {
    return { provider, status: 'no_credentials', account: null, usage: null };
  }

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...buildHeaders(cred) },
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        provider,
        status: 'error',
        account: null,
        usage: null,
        error: `${provider} API ${res.status}: ${text}`,
      };
    }

    const data: TData = await res.json();
    const mapped = mapResult(cred, data);
    return { provider, status: 'ok', ...mapped };
  } catch (err) {
    return { provider, status: 'error', account: null, usage: null, error: getErrorMessage(err) };
  }
}

// ─── Claude ────────────────────────────────────────────────────

interface ClaudeUsagePeriod {
  utilization: number;
  resets_at: string | null;
}

interface ClaudeUsageApiResponse {
  five_hour: ClaudeUsagePeriod | null;
  seven_day: ClaudeUsagePeriod | null;
  seven_day_opus: ClaudeUsagePeriod | null;
  seven_day_sonnet: ClaudeUsagePeriod | null;
  seven_day_cowork: ClaudeUsagePeriod | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
}

type ClaudeCredentials = NonNullable<ReturnType<typeof readClaudeCredentials>>;

export function fetchClaudeUsage(): Promise<UsageResult> {
  return fetchProviderUsage<ClaudeCredentials, ClaudeUsageApiResponse>({
    provider: 'claude',
    getCredential: readClaudeCredentials,
    url: 'https://api.anthropic.com/api/oauth/usage',
    buildHeaders: (auth) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    }),
    mapResult: (auth, data) => ({
      account: {
        subscriptionType: auth.subscriptionType ?? null,
        rateLimitTier: auth.rateLimitTier ?? null,
      },
      usage: {
        fiveHour: data.five_hour,
        sevenDay: data.seven_day,
        sevenDayOpus: data.seven_day_opus,
        sevenDaySonnet: data.seven_day_sonnet,
        sevenDayCowork: data.seven_day_cowork,
        extraUsage: data.extra_usage,
      },
    }),
  });
}

// ─── OpenAI ────────────────────────────────────────────────────

interface OpenAIMeResponse {
  id: string;
  name: string;
  email: string;
  orgs?: {
    data: Array<{
      id: string;
      name: string;
      title: string;
      personal: boolean;
    }>;
  };
}

export function fetchOpenAIUsage(): Promise<UsageResult> {
  return fetchProviderUsage<string, OpenAIMeResponse>({
    provider: 'openai',
    getCredential: readCodexOAuthToken,
    url: 'https://api.openai.com/v1/me',
    buildHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    mapResult: (_token, data) => ({
      account: {
        userId: data.id,
        name: data.name,
        email: data.email,
        organizations: (data.orgs?.data ?? []).map((org) => ({
          id: org.id,
          name: org.name,
          title: org.title,
          personal: org.personal,
        })),
      },
      usage: null,
      note: 'Usage/billing data requires an Admin API key from platform.openai.com. CLI OAuth tokens can only access account info.',
    }),
  });
}

// ─── Gemini ────────────────────────────────────────────────────

interface GoogleUserInfoResponse {
  sub: string;
  name: string;
  email: string;
  email_verified?: boolean;
  picture?: string;
}

export function fetchGeminiUsage(): Promise<UsageResult> {
  return fetchProviderUsage<string, GoogleUserInfoResponse>({
    provider: 'gemini',
    getCredential: readGeminiOAuthToken,
    url: 'https://www.googleapis.com/oauth2/v3/userinfo',
    buildHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    mapResult: (_token, data) => ({
      account: {
        userId: data.sub,
        name: data.name,
        email: data.email,
      },
      usage: null,
      note: 'Google does not expose a usage API for Gemini CLI OAuth credentials. Usage can be viewed at console.cloud.google.com.',
    }),
  });
}

// ─── Unified ───────────────────────────────────────────────────

/** Fetch usage/account info from all providers in parallel. */
export async function fetchAllUsage(): Promise<UsageResult[]> {
  return Promise.all([fetchClaudeUsage(), fetchOpenAIUsage(), fetchGeminiUsage()]);
}
