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
import {
  validateWorkingDir,
  buildChildEnv,
  buildCommandArgs,
  validateArgs,
  validateBinary,
} from '@/lib/worker/safety';

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

  describe('buildChildEnv', () => {
    it('includes allowlisted env vars only', () => {
      const originalPath = process.env.PATH;
      const originalHome = process.env.HOME;
      process.env.PATH = '/usr/bin';
      process.env.HOME = '/home/test';
      process.env.SECRET_KEY = 'should-not-appear';

      const env = buildChildEnv();

      expect(env.PATH).toBe('/usr/bin');
      expect(env.HOME).toBe('/home/test');
      expect(env.TERM).toBe('xterm-256color');
      expect(env.COLORTERM).toBe('truecolor');
      expect(env).not.toHaveProperty('SECRET_KEY');

      process.env.PATH = originalPath;
      process.env.HOME = originalHome;
    });

    it('includes agent-specific allowlisted vars', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const env = buildChildEnv({ agentAllowlist: ['ANTHROPIC_API_KEY'] });
      expect(env.ANTHROPIC_API_KEY).toBe('test-key');
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('never spreads process.env', () => {
      const env = buildChildEnv();
      // Should have limited keys, not hundreds from process.env
      const keys = Object.keys(env);
      expect(keys.length).toBeLessThan(15);
    });
  });

  describe('buildCommandArgs', () => {
    it('substitutes placeholders with arg values', () => {
      const result = buildCommandArgs(['git', 'checkout', '{{branch}}'], { branch: 'main' });
      expect(result).toEqual(['git', 'checkout', 'main']);
    });

    it('preserves literal tokens', () => {
      const result = buildCommandArgs(['git', 'status'], {});
      expect(result).toEqual(['git', 'status']);
    });

    it('throws for missing required arguments', () => {
      expect(() => buildCommandArgs(['git', 'checkout', '{{branch}}'], {})).toThrow(
        'Missing required argument: branch',
      );
    });

    it('rejects object values in token positions', () => {
      expect(() => buildCommandArgs(['test', '{{arg}}'], { arg: { nested: true } })).toThrow(
        'Object/array values not allowed',
      );
    });

    it('rejects values with unsafe characters', () => {
      expect(() => buildCommandArgs(['test', '{{arg}}'], { arg: '; rm -rf /' })).toThrow(
        'disallowed characters',
      );
    });
  });

  describe('validateArgs', () => {
    it('passes when no schema provided', () => {
      expect(() => validateArgs(null, { anything: 'goes' })).not.toThrow();
    });

    it('rejects object arg values', () => {
      expect(() => validateArgs({}, { nested: { bad: true } })).toThrow('must be a scalar value');
    });

    it('validates required fields from schema', () => {
      const schema = { required: ['name'] };
      expect(() => validateArgs(schema, {})).toThrow('Missing required argument: name');
    });

    it('validates pattern constraints', () => {
      const schema = {
        properties: { branch: { pattern: '^[a-zA-Z0-9/-]+$' } },
      };
      expect(() => validateArgs(schema, { branch: 'main; evil' })).toThrow(
        'does not match pattern',
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
