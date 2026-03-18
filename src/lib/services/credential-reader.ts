/**
 * Shared credential readers for CLI-stored auth tokens.
 *
 * Reads from local credential files (no env vars).
 * Used by both ai-call.ts and usage API routes.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Claude ────────────────────────────────────────────────────

interface ClaudeOAuthCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

export interface ClaudeCredentialResult {
  token: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** Read Claude OAuth credentials from ~/.claude/.credentials.json */
export function readClaudeCredentials(): ClaudeCredentialResult | null {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const raw = readFileSync(credPath, 'utf-8');
    const creds: ClaudeOAuthCredentials = JSON.parse(raw);
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

/** Read just the Claude OAuth access token (convenience for ai-call.ts) */
export function readClaudeOAuthToken(): string | null {
  return readClaudeCredentials()?.token ?? null;
}

// ─── Codex (OpenAI) ────────────────────────────────────────────

interface CodexAuthFile {
  OPENAI_API_KEY?: string;
  token?: string;
  access_token?: string;
  tokens?: {
    access_token?: string;
    id_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

/**
 * Read Codex auth token from ~/.codex/auth.json.
 *
 * The file has multiple possible token locations:
 * - `OPENAI_API_KEY` — platform API key (for AI calls)
 * - `tokens.access_token` — OAuth token (for user-facing APIs like /v1/me)
 * - `token` / `access_token` — legacy formats
 */
export function readCodexToken(): string | null {
  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    const raw = readFileSync(authPath, 'utf-8');
    const auth: CodexAuthFile = JSON.parse(raw);
    return auth.OPENAI_API_KEY ?? auth.token ?? auth.access_token ?? null;
  } catch {
    return null;
  }
}

/** Read Codex OAuth token (from tokens.access_token) for user-facing APIs like /v1/me */
export function readCodexOAuthToken(): string | null {
  try {
    const authPath = join(homedir(), '.codex', 'auth.json');
    const raw = readFileSync(authPath, 'utf-8');
    const auth: CodexAuthFile = JSON.parse(raw);
    return auth.tokens?.access_token ?? null;
  } catch {
    return null;
  }
}

// ─── Gemini ────────────────────────────────────────────────────

/** Read Gemini OAuth token from ~/.gemini/oauth_creds.json */
export function readGeminiOAuthToken(): string | null {
  try {
    const credPath = join(homedir(), '.gemini', 'oauth_creds.json');
    const raw = readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw) as { access_token?: string; token?: string };
    return creds.access_token ?? creds.token ?? null;
  } catch {
    return null;
  }
}
