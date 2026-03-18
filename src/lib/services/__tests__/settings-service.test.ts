import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const _mockMkdirSync = vi.mocked(mkdirSync);

// Must import AFTER mocks
const { getSetting, setSetting, getAiProviderPreference, setAiProviderPreference, SETTINGS_PATH } =
  await import('../settings-service');

describe('settings-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: settings file doesn't exist
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
  });

  describe('getSetting', () => {
    it('returns undefined when settings file does not exist', () => {
      const result = getSetting('ai_provider_preference');
      expect(result).toBeUndefined();
    });

    it('returns undefined when key is not in settings', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ other_key: 'value' }));
      const result = getSetting('ai_provider_preference');
      expect(result).toBeUndefined();
    });

    it('returns value when key exists', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ ai_provider_preference: 'anthropic' }));
      const result = getSetting('ai_provider_preference');
      expect(result).toBe('anthropic');
    });

    it('handles corrupted JSON gracefully', () => {
      mockReadFileSync.mockReturnValue('not valid json{{{');
      const result = getSetting('ai_provider_preference');
      expect(result).toBeUndefined();
    });
  });

  describe('setSetting', () => {
    it('creates directory and writes file when settings file does not exist', () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      setSetting('ai_provider_preference', 'openai');

      expect(_mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        SETTINGS_PATH,
        expect.stringContaining('"ai_provider_preference": "openai"'),
        'utf-8',
      );
    });

    it('preserves existing settings when adding a new key', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ existing_key: 'existing_value' }));

      setSetting('ai_provider_preference', 'gemini');

      const writtenJson = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;
      expect(writtenJson.existing_key).toBe('existing_value');
      expect(writtenJson.ai_provider_preference).toBe('gemini');
    });

    it('overwrites existing value for the same key', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ ai_provider_preference: 'anthropic' }));

      setSetting('ai_provider_preference', 'openai');

      const writtenJson = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;
      expect(writtenJson.ai_provider_preference).toBe('openai');
    });
  });

  describe('getAiProviderPreference', () => {
    it('returns "auto" when no setting is stored', () => {
      expect(getAiProviderPreference()).toBe('auto');
    });

    it('returns stored preference', () => {
      mockReadFileSync.mockReturnValue(JSON.stringify({ ai_provider_preference: 'gemini' }));
      expect(getAiProviderPreference()).toBe('gemini');
    });

    it('returns "auto" for invalid stored value', () => {
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ ai_provider_preference: 'invalid-provider' }),
      );
      expect(getAiProviderPreference()).toBe('auto');
    });
  });

  describe('setAiProviderPreference', () => {
    it('stores valid provider preference', () => {
      setAiProviderPreference('anthropic');

      const writtenJson = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;
      expect(writtenJson.ai_provider_preference).toBe('anthropic');
    });

    it('stores "auto" preference', () => {
      setAiProviderPreference('auto');

      const writtenJson = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string) as Record<
        string,
        unknown
      >;
      expect(writtenJson.ai_provider_preference).toBe('auto');
    });

    it('throws for invalid provider value', () => {
      expect(() => setAiProviderPreference('invalid' as 'auto')).toThrow();
    });
  });

  describe('SETTINGS_PATH', () => {
    it('is under /data/agendo/', () => {
      expect(SETTINGS_PATH).toContain('/data/agendo/');
      expect(SETTINGS_PATH).toMatch(/settings\.json$/);
    });
  });
});
