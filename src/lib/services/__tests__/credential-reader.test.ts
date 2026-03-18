import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);

// Must import AFTER mocks are set up
const { readClaudeCredentials, readCodexToken, readGeminiOAuthToken } =
  await import('../credential-reader');

describe('credential-reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  describe('readClaudeCredentials', () => {
    it('returns null when credentials file not found', () => {
      expect(readClaudeCredentials()).toBeNull();
    });

    it('returns null when accessToken is missing', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: {} }));
      expect(readClaudeCredentials()).toBeNull();
    });

    it('returns token and metadata when credentials exist', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'test-token',
            subscriptionType: 'max_5x',
            rateLimitTier: 'tier4',
          },
        }),
      );
      const result = readClaudeCredentials();
      expect(result).toEqual({
        token: 'test-token',
        subscriptionType: 'max_5x',
        rateLimitTier: 'tier4',
      });
    });

    it('returns token with optional fields undefined when not present', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ claudeAiOauth: { accessToken: 'token-only' } }),
      );
      const result = readClaudeCredentials();
      expect(result).not.toBeNull();
      expect(result!.token).toBe('token-only');
      expect(result!.subscriptionType).toBeUndefined();
    });
  });

  describe('readCodexToken', () => {
    it('returns null when auth file not found', () => {
      expect(readCodexToken()).toBeNull();
    });

    it('reads token from OPENAI_API_KEY field', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ OPENAI_API_KEY: 'sk-codex-key' }));
      expect(readCodexToken()).toBe('sk-codex-key');
    });

    it('reads token from token field', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ token: 'tok-123' }));
      expect(readCodexToken()).toBe('tok-123');
    });

    it('reads token from access_token field', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ access_token: 'at-123' }));
      expect(readCodexToken()).toBe('at-123');
    });

    it('returns null for empty object', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({}));
      expect(readCodexToken()).toBeNull();
    });
  });

  describe('readGeminiOAuthToken', () => {
    it('returns null when credentials file not found', () => {
      expect(readGeminiOAuthToken()).toBeNull();
    });

    it('reads access_token field', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ access_token: 'gemini-at' }));
      expect(readGeminiOAuthToken()).toBe('gemini-at');
    });

    it('reads token field as fallback', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ token: 'gemini-tok' }));
      expect(readGeminiOAuthToken()).toBe('gemini-tok');
    });

    it('returns null for empty object', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({}));
      expect(readGeminiOAuthToken()).toBeNull();
    });
  });
});
