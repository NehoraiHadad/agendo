import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkForUpdates, type VersionCheckResult } from '../version-service';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

const mockExecFile = vi.mocked(execFile);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);

function mockGitTags(tags: string[]) {
  // First call: git fetch --tags (void callback)
  // Second call: git tag -l 'v*' (returns tag list)
  let callCount = 0;
  mockExecFile.mockImplementation(((
    _cmd: string,
    _args: readonly string[],
    _opts: unknown,
    cb?: ExecFileCallback,
  ) => {
    const callback = (cb ?? _opts) as ExecFileCallback;
    callCount++;
    if (callCount === 1) {
      // git fetch --tags
      callback(null, '', '');
    } else {
      // git tag -l 'v*'
      callback(null, tags.join('\n'), '');
    }
  }) as typeof execFile);
}

function mockGitFetchFailure() {
  let callCount = 0;
  mockExecFile.mockImplementation(((
    _cmd: string,
    _args: readonly string[],
    _opts: unknown,
    cb?: ExecFileCallback,
  ) => {
    const callback = (cb ?? _opts) as ExecFileCallback;
    callCount++;
    if (callCount === 1) {
      // git fetch fails
      callback(new Error('network error'), '', '');
    } else {
      // git tag -l still works (local tags)
      callback(null, 'v0.1.0', '');
    }
  }) as typeof execFile);
}

describe('version-service', () => {
  const originalEnv = process.env.NEXT_PUBLIC_APP_VERSION;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_VERSION = '0.1.0';
    // Default: no cache file
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_APP_VERSION = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_APP_VERSION;
    }
  });

  it('detects when an update is available', async () => {
    mockGitTags(['v0.1.0', 'v0.2.0', 'v0.1.1']);

    const result = await checkForUpdates({ forceRefresh: true });

    expect(result.currentVersion).toBe('0.1.0');
    expect(result.latestVersion).toBe('0.2.0');
    expect(result.updateAvailable).toBe(true);
  });

  it('returns updateAvailable=false when up to date', async () => {
    mockGitTags(['v0.1.0']);

    const result = await checkForUpdates({ forceRefresh: true });

    expect(result.currentVersion).toBe('0.1.0');
    expect(result.latestVersion).toBe('0.1.0');
    expect(result.updateAvailable).toBe(false);
  });

  it('returns null latestVersion when no tags exist', async () => {
    mockGitTags([]);

    const result = await checkForUpdates({ forceRefresh: true });

    expect(result.latestVersion).toBeNull();
    expect(result.updateAvailable).toBe(false);
  });

  it('uses cached result within TTL', async () => {
    const cached: VersionCheckResult = {
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(cached));

    const result = await checkForUpdates();

    expect(result).toEqual(cached);
    // Should NOT have called git
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('ignores stale cache', async () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const cached: VersionCheckResult = {
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      updateAvailable: false,
      checkedAt: staleDate,
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(cached));
    mockGitTags(['v0.1.0', 'v0.2.0']);

    const result = await checkForUpdates();

    expect(result.latestVersion).toBe('0.2.0');
    expect(result.updateAvailable).toBe(true);
  });

  it('handles git fetch failure gracefully', async () => {
    mockGitFetchFailure();

    const result = await checkForUpdates({ forceRefresh: true });

    // Should still return a result using local tags
    expect(result.currentVersion).toBe('0.1.0');
    expect(result.latestVersion).toBe('0.1.0');
    expect(result.updateAvailable).toBe(false);
  });

  it('writes cache after successful check', async () => {
    mockGitTags(['v0.1.0']);

    await checkForUpdates({ forceRefresh: true });

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
    expect(written.currentVersion).toBe('0.1.0');
    expect(written.checkedAt).toBeDefined();
  });

  it('ignores non-semver tags', async () => {
    mockGitTags(['v0.1.0', 'some-tag', 'v0.2.0', 'release-candidate']);

    const result = await checkForUpdates({ forceRefresh: true });

    expect(result.latestVersion).toBe('0.2.0');
  });

  it('forceRefresh bypasses cache', async () => {
    const cached: VersionCheckResult = {
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      updateAvailable: false,
      checkedAt: new Date().toISOString(), // fresh
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(cached));
    mockGitTags(['v0.1.0', 'v0.3.0']);

    const result = await checkForUpdates({ forceRefresh: true });

    expect(result.latestVersion).toBe('0.3.0');
    expect(result.updateAvailable).toBe(true);
  });
});
