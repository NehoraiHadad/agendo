import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { aiCall, getAvailableProviders } from '../ai-call';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('ai-call', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear all API keys
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('getAvailableProviders', () => {
    it('returns empty when no keys configured', () => {
      expect(getAvailableProviders()).toEqual([]);
    });

    it('detects Anthropic key', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      expect(getAvailableProviders()).toContain('anthropic');
    });

    it('detects OpenAI key', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      expect(getAvailableProviders()).toContain('openai');
    });

    it('detects Gemini key from GEMINI_API_KEY', () => {
      process.env.GEMINI_API_KEY = 'test-key';
      expect(getAvailableProviders()).toContain('gemini');
    });

    it('detects Gemini key from GOOGLE_API_KEY', () => {
      process.env.GOOGLE_API_KEY = 'test-key';
      expect(getAvailableProviders()).toContain('gemini');
    });

    it('returns providers in priority order: anthropic, openai, gemini', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.GEMINI_API_KEY = 'test-key';

      const providers = getAvailableProviders();
      expect(providers).toEqual(['anthropic', 'openai', 'gemini']);
    });
  });

  describe('aiCall', () => {
    it('throws when no providers available', async () => {
      await expect(aiCall({ prompt: 'test' })).rejects.toThrow(
        'No AI provider API keys configured',
      );
    });

    it('calls Anthropic API when key is available', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Hello from Claude' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });

      const result = await aiCall({ prompt: 'Say hello' });

      expect(result.text).toBe('Hello from Claude');
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.tokens).toEqual({ input: 10, output: 5 });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'x-api-key': 'sk-ant-test',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );
    });

    it('calls OpenAI API when Anthropic is unavailable', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hello from GPT' } }],
          model: 'gpt-4o-mini',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

      const result = await aiCall({ prompt: 'Say hello' });

      expect(result.text).toBe('Hello from GPT');
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o-mini');
    });

    it('calls Gemini API when others unavailable', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] } }],
          modelVersion: 'gemini-2.0-flash',
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
      });

      const result = await aiCall({ prompt: 'Say hello' });

      expect(result.text).toBe('Hello from Gemini');
      expect(result.provider).toBe('gemini');
    });

    it('respects preferredProvider', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.OPENAI_API_KEY = 'sk-test';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'From OpenAI' } }],
          model: 'gpt-4o-mini',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

      const result = await aiCall({ prompt: 'test', preferredProvider: 'openai' });

      expect(result.provider).toBe('openai');
    });

    it('falls back to next provider on API error', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      process.env.OPENAI_API_KEY = 'sk-test';

      // Anthropic fails
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      // OpenAI succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Fallback to OpenAI' } }],
          model: 'gpt-4o-mini',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      });

      const result = await aiCall({ prompt: 'test' });

      expect(result.provider).toBe('openai');
      expect(result.text).toBe('Fallback to OpenAI');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws when all providers fail', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Error',
      });

      await expect(aiCall({ prompt: 'test' })).rejects.toThrow('All AI providers failed');
    });

    it('uses maxTokens option', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Short' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 10, output_tokens: 3 },
        }),
      });

      await aiCall({ prompt: 'test', maxTokens: 50 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.max_tokens).toBe(50);
    });
  });
});
