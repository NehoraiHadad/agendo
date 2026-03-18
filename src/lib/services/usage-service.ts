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

// ─── Claude ────────────────────────────────────────────────────

interface ClaudeUsagePeriod {
  utilization: number;
  resets_at: string | null;
}

interface ClaudeUsageApiResponse {
  five_hour: ClaudeUsagePeriod | null;
  seven_day: ClaudeUsagePeriod | null;
  seven_day_opus: ClaudeUsagePeriod | null;
  seven_day_sonnet: ClauseUsagePeriod | null;
  seven_day_cowork: ClaudeUsagePeriod | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
}

// Fix the typo — both should be ClaudeUsagePeriod
type ClauseUsagePeriod = ClaudeUsagePeriod;

export async function fetchClaudeUsage(): Promise<UsageResult> {
  const auth = readClaudeCredentials();
  if (!auth) {
    return { provider: 'claude', status: 'no_credentials', account: null, usage: null };
  }

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${auth.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        provider: 'claude',
        status: 'error',
        account: null,
        usage: null,
        error: `Anthropic API ${res.status}: ${text}`,
      };
    }

    const data: ClaudeUsageApiResponse = await res.json();

    return {
      provider: 'claude',
      status: 'ok',
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
    };
  } catch (err) {
    return {
      provider: 'claude',
      status: 'error',
      account: null,
      usage: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

export async function fetchOpenAIUsage(): Promise<UsageResult> {
  const token = readCodexOAuthToken();
  if (!token) {
    return { provider: 'openai', status: 'no_credentials', account: null, usage: null };
  }

  try {
    const res = await fetch('https://api.openai.com/v1/me', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        provider: 'openai',
        status: 'error',
        account: null,
        usage: null,
        error: `OpenAI API ${res.status}: ${text}`,
      };
    }

    const data: OpenAIMeResponse = await res.json();

    return {
      provider: 'openai',
      status: 'ok',
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
    };
  } catch (err) {
    return {
      provider: 'openai',
      status: 'error',
      account: null,
      usage: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Gemini ────────────────────────────────────────────────────

interface GoogleUserInfoResponse {
  sub: string;
  name: string;
  email: string;
  email_verified?: boolean;
  picture?: string;
}

export async function fetchGeminiUsage(): Promise<UsageResult> {
  const token = readGeminiOAuthToken();
  if (!token) {
    return { provider: 'gemini', status: 'no_credentials', account: null, usage: null };
  }

  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        provider: 'gemini',
        status: 'error',
        account: null,
        usage: null,
        error: `Google API ${res.status}: ${text}`,
      };
    }

    const data: GoogleUserInfoResponse = await res.json();

    return {
      provider: 'gemini',
      status: 'ok',
      account: {
        userId: data.sub,
        name: data.name,
        email: data.email,
      },
      usage: null,
      note: 'Google does not expose a usage API for Gemini CLI OAuth credentials. Usage can be viewed at console.cloud.google.com.',
    };
  } catch (err) {
    return {
      provider: 'gemini',
      status: 'error',
      account: null,
      usage: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Unified ───────────────────────────────────────────────────

/** Fetch usage/account info from all providers in parallel. */
export async function fetchAllUsage(): Promise<UsageResult[]> {
  return Promise.all([fetchClaudeUsage(), fetchOpenAIUsage(), fetchGeminiUsage()]);
}
