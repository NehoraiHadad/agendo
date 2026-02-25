import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface OAuthCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface UsagePeriod {
  utilization: number;
  resets_at: string | null;
}

interface ClaudeUsageResponse {
  five_hour: UsagePeriod | null;
  seven_day: UsagePeriod | null;
  seven_day_opus: UsagePeriod | null;
  seven_day_sonnet: UsagePeriod | null;
  seven_day_cowork: UsagePeriod | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
}

function readOAuthToken(): {
  token: string;
  subscriptionType?: string;
  rateLimitTier?: string;
} | null {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const raw = readFileSync(credPath, 'utf-8');
    const creds: OAuthCredentials = JSON.parse(raw);
    if (!creds.claudeAiOauth?.accessToken) return null;
    return {
      token: creds.claudeAiOauth.accessToken,
      subscriptionType: creds.claudeAiOauth.subscriptionType,
      rateLimitTier: creds.claudeAiOauth.rateLimitTier,
    };
  } catch {
    return null;
  }
}

export const GET = withErrorBoundary(async () => {
  const auth = readOAuthToken();
  if (!auth) {
    return NextResponse.json(
      { error: { code: 'NO_CREDENTIALS', message: 'Claude OAuth credentials not found' } },
      { status: 503 },
    );
  }

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    // No caching — always fresh
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: { code: 'UPSTREAM_ERROR', message: `Anthropic API ${res.status}: ${text}` } },
      { status: 502 },
    );
  }

  const usage: ClaudeUsageResponse = await res.json();

  return NextResponse.json({
    data: {
      subscriptionType: auth.subscriptionType ?? null,
      rateLimitTier: auth.rateLimitTier ?? null,
      fiveHour: usage.five_hour,
      sevenDay: usage.seven_day,
      sevenDayOpus: usage.seven_day_opus,
      sevenDaySonnet: usage.seven_day_sonnet,
      sevenDayCowork: usage.seven_day_cowork,
      extraUsage: usage.extra_usage,
    },
  });
});
