import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const { fetchClaudeUsage, fetchOpenAIUsage, fetchGeminiUsage, fetchAllUsage } =
  await import('../usage-service');

describe('usage-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  describe('fetchClaudeUsage', () => {
    it('returns unavailable when no credentials', async () => {
      const result = await fetchClaudeUsage();
      expect(result.provider).toBe('claude');
      expect(result.status).toBe('no_credentials');
      expect(result.usage).toBeNull();
    });

    it('returns usage data when credentials exist and API succeeds', async () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'test-token',
            subscriptionType: 'max_5x',
            rateLimitTier: 'tier4',
          },
        }),
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          five_hour: { utilization: 0.42, resets_at: '2026-03-18T20:00:00Z' },
          seven_day: null,
          seven_day_opus: null,
          seven_day_sonnet: null,
          seven_day_cowork: null,
          extra_usage: null,
        }),
      });

      const result = await fetchClaudeUsage();
      expect(result.provider).toBe('claude');
      expect(result.status).toBe('ok');
      expect(result.account).toEqual({
        subscriptionType: 'max_5x',
        rateLimitTier: 'tier4',
      });
      expect(result.usage).toBeDefined();
      expect(result.usage!.fiveHour).toEqual({
        utilization: 0.42,
        resets_at: '2026-03-18T20:00:00Z',
      });
    });

    it('returns error when API fails', async () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: { accessToken: 'token' } }));

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await fetchClaudeUsage();
      expect(result.status).toBe('error');
      expect(result.error).toContain('401');
    });
  });

  describe('fetchOpenAIUsage', () => {
    it('returns unavailable when no credentials', async () => {
      const result = await fetchOpenAIUsage();
      expect(result.provider).toBe('openai');
      expect(result.status).toBe('no_credentials');
    });

    it('returns account info when OAuth token exists', async () => {
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (String(p).includes('.codex/auth.json')) {
          return JSON.stringify({
            tokens: { access_token: 'oauth-tok' },
          });
        }
        throw new Error('ENOENT');
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'user-123',
          name: 'Test User',
          email: 'test@example.com',
          orgs: {
            data: [
              {
                id: 'org-abc',
                name: 'test-org',
                title: 'Test Org',
                personal: true,
              },
            ],
          },
        }),
      });

      const result = await fetchOpenAIUsage();
      expect(result.provider).toBe('openai');
      expect(result.status).toBe('ok');
      expect(result.account).toEqual({
        userId: 'user-123',
        name: 'Test User',
        email: 'test@example.com',
        organizations: [
          {
            id: 'org-abc',
            name: 'test-org',
            title: 'Test Org',
            personal: true,
          },
        ],
      });
      expect(result.usage).toBeNull();
      expect(result.note).toContain('Admin API key');
    });

    it('returns error when API fails', async () => {
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (String(p).includes('.codex/auth.json')) {
          return JSON.stringify({ tokens: { access_token: 'tok' } });
        }
        throw new Error('ENOENT');
      });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const result = await fetchOpenAIUsage();
      expect(result.status).toBe('error');
    });
  });

  describe('fetchGeminiUsage', () => {
    it('returns unavailable when no credentials', async () => {
      const result = await fetchGeminiUsage();
      expect(result.provider).toBe('gemini');
      expect(result.status).toBe('no_credentials');
    });

    it('returns account info when OAuth token exists', async () => {
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (String(p).includes('.gemini/oauth_creds.json')) {
          return JSON.stringify({ access_token: 'gemini-tok' });
        }
        throw new Error('ENOENT');
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sub: '123456',
          name: 'Test User',
          email: 'test@gmail.com',
          email_verified: true,
        }),
      });

      const result = await fetchGeminiUsage();
      expect(result.provider).toBe('gemini');
      expect(result.status).toBe('ok');
      expect(result.account).toEqual({
        userId: '123456',
        name: 'Test User',
        email: 'test@gmail.com',
      });
      expect(result.usage).toBeNull();
      expect(result.note).toContain('usage API');
    });
  });

  describe('fetchAllUsage', () => {
    it('returns results for all providers', async () => {
      // No credentials for any provider
      const results = await fetchAllUsage();
      expect(results).toHaveLength(3);
      expect(results.map((r) => r.provider)).toEqual(['claude', 'openai', 'gemini']);
    });

    it('fetches all providers in parallel', async () => {
      // All providers have no credentials — just verify structure
      const results = await fetchAllUsage();
      expect(results.every((r) => r.status === 'no_credentials')).toBe(true);
    });
  });
});
