import { describe, it, expect } from 'vitest';
import { readConfigFile, writeConfigFile } from '../config-service.demo';

describe('config-service.demo', () => {
  describe('readConfigFile', () => {
    it('returns empty content and the provided path', async () => {
      const result = await readConfigFile('/some/path/CLAUDE.md');
      expect(result).toEqual({ content: '', path: '/some/path/CLAUDE.md' });
    });

    it('does not throw for any path', async () => {
      await expect(readConfigFile('~/.claude/settings.json')).resolves.toBeDefined();
    });
  });

  describe('writeConfigFile', () => {
    it('does not throw and returns void', async () => {
      await expect(writeConfigFile('/some/path/CLAUDE.md', '# My Config')).resolves.toBeUndefined();
    });
  });
});
