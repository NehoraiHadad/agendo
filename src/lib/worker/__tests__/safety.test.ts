import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config
vi.mock('@/lib/config', () => ({
  config: { LOG_DIR: '/tmp/test-logs' },
  allowedWorkingDirs: ['/home/ubuntu/projects', '/tmp'],
}));

// Mock fs
vi.mock('node:fs', () => ({
  realpathSync: vi.fn((p: string) => p),
  accessSync: vi.fn(),
  existsSync: vi.fn(() => true),
  constants: { X_OK: 1 },
}));

// Mock db — validateWorkingDir falls back to DB when path not in static allowlist
vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

import { realpathSync, accessSync, existsSync } from 'node:fs';
import { validateWorkingDir, validateBinary } from '@/lib/worker/safety';

describe('safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(realpathSync).mockImplementation((p) => p.toString());
  });

  describe('validateWorkingDir', () => {
    it('accepts directory in allowlist', async () => {
      await expect(validateWorkingDir('/home/ubuntu/projects/my-app')).resolves.toBe(
        '/home/ubuntu/projects/my-app',
      );
    });

    it('accepts exact allowlist match', async () => {
      await expect(validateWorkingDir('/tmp')).resolves.toBe('/tmp');
    });

    it('rejects relative paths', async () => {
      await expect(validateWorkingDir('relative/path')).rejects.toThrow('must be absolute');
    });

    it('rejects non-existent directories', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      await expect(validateWorkingDir('/home/ubuntu/projects/nope')).rejects.toThrow(
        'does not exist',
      );
    });

    it('rejects directory outside allowlist', async () => {
      await expect(validateWorkingDir('/etc/secret')).rejects.toThrow('not in allowlist');
    });

    it('prevents symlink traversal by resolving before allowlist check', async () => {
      vi.mocked(realpathSync).mockReturnValue('/etc/secret');
      await expect(validateWorkingDir('/home/ubuntu/projects/symlink')).rejects.toThrow(
        'not in allowlist',
      );
    });
  });

  describe('validateBinary', () => {
    it('passes for executable binary', () => {
      vi.mocked(accessSync).mockImplementation(() => {});
      expect(() => validateBinary('/usr/bin/git')).not.toThrow();
    });

    it('throws for non-executable binary', () => {
      vi.mocked(accessSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(() => validateBinary('/nonexistent')).toThrow('not found or not executable');
    });
  });
});
