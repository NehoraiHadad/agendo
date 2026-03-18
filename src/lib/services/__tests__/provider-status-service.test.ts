import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';

// Mock fs and os
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

// Import after mocks
const { getAllProviderStatuses } = await import('../provider-status-service');

describe('provider-status-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no files exist, no env vars
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    // Clear relevant env vars
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GITHUB_TOKEN;
    delete process.env.COPILOT_GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  it('returns status for all four core providers', () => {
    // ecosystem.config.js mock (no env vars set)
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).includes('ecosystem.config.js')) {
        return `module.exports = { apps: [{ name: 'agendo-worker', env: {} }] }`;
      }
      throw new Error('ENOENT');
    });

    const result = getAllProviderStatuses();

    expect(result).toHaveLength(4);
    const names = result.map((r) => r.binaryName);
    expect(names).toEqual(['claude', 'codex', 'gemini', 'copilot']);
  });

  it('each result has the expected shape', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).includes('ecosystem.config.js')) {
        return `module.exports = { apps: [{ name: 'agendo-worker', env: {} }] }`;
      }
      throw new Error('ENOENT');
    });

    const result = getAllProviderStatuses();

    for (const status of result) {
      expect(status).toHaveProperty('binaryName');
      expect(status).toHaveProperty('displayName');
      expect(status).toHaveProperty('isAuthenticated');
      expect(status).toHaveProperty('method');
      expect(status).toHaveProperty('envVarDetails');
      expect(['env-var', 'credential-file', 'both', 'none']).toContain(status.method);
    }
  });

  it('detects env var authentication', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).includes('ecosystem.config.js')) {
        return `module.exports = { apps: [{ name: 'agendo-worker', env: {} }] }`;
      }
      throw new Error('ENOENT');
    });

    const result = getAllProviderStatuses();
    const claude = result.find((r) => r.binaryName === 'claude');

    expect(claude).toBeDefined();
    expect(claude!.isAuthenticated).toBe(true);
    expect(claude!.method).toBe('env-var');
  });

  it('detects credential file authentication', () => {
    mockExistsSync.mockImplementation((p) => {
      return String(p).includes('.claude/credentials.json');
    });
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).includes('ecosystem.config.js')) {
        return `module.exports = { apps: [{ name: 'agendo-worker', env: {} }] }`;
      }
      throw new Error('ENOENT');
    });

    const result = getAllProviderStatuses();
    const claude = result.find((r) => r.binaryName === 'claude');

    expect(claude).toBeDefined();
    expect(claude!.isAuthenticated).toBe(true);
    expect(claude!.method).toBe('credential-file');
  });

  it('shows unauthenticated when nothing is configured', () => {
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).includes('ecosystem.config.js')) {
        return `module.exports = { apps: [{ name: 'agendo-worker', env: {} }] }`;
      }
      throw new Error('ENOENT');
    });

    const result = getAllProviderStatuses();

    for (const status of result) {
      expect(status.isAuthenticated).toBe(false);
      expect(status.method).toBe('none');
    }
  });
});
