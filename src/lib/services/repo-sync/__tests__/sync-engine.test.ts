import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SyncTarget, SyncManifest } from '../types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

// ─── Test fixtures ──────────────────────────────────────────────────────────

const TEST_TARGET: SyncTarget = {
  id: 'test-repo',
  repoUrl: 'https://github.com/example/test-repo',
  branch: 'main',
  mappings: [{ src: 'src/lib', dest: '/tmp/agendo-sync-test/dest/lib' }],
  enabled: true,
};

const MANIFEST_PATH = '/tmp/agendo-sync-test/.repo-sync-manifest.json';

// ─── Import after mocks ────────────────────────────────────────────────────

// We'll import these after mocks are set up
let syncTarget: typeof import('../sync-engine').syncTarget;
let loadManifest: typeof import('../sync-engine').loadManifest;
let saveManifest: typeof import('../sync-engine').saveManifest;
let getHeadCommit: typeof import('../sync-engine').getHeadCommit;
let cloneRepo: typeof import('../sync-engine').cloneRepo;

beforeEach(async () => {
  vi.resetAllMocks();
  // Dynamic import to ensure mocks are in place
  const mod = await import('../sync-engine');
  syncTarget = mod.syncTarget;
  loadManifest = mod.loadManifest;
  saveManifest = mod.saveManifest;
  getHeadCommit = mod.getHeadCommit;
  cloneRepo = mod.cloneRepo;
});

afterEach(() => {
  // Clean up test artifacts
  fs.rmSync('/tmp/agendo-sync-test', { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('loadManifest', () => {
  it('returns empty manifest when file does not exist', () => {
    const manifest = loadManifest('/tmp/agendo-sync-test/nonexistent.json');
    expect(manifest).toEqual({ version: 1, records: [] });
  });

  it('loads and parses existing manifest', () => {
    const data: SyncManifest = {
      version: 1,
      records: [
        {
          targetId: 'test-repo',
          lastCommit: 'abc123',
          lastSyncedAt: '2026-01-01T00:00:00.000Z',
          syncedFiles: ['lib/foo.ts'],
        },
      ],
    };
    fs.mkdirSync('/tmp/agendo-sync-test', { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(data));
    const manifest = loadManifest(MANIFEST_PATH);
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0].lastCommit).toBe('abc123');
  });
});

describe('saveManifest', () => {
  it('creates parent directories and writes manifest', () => {
    const manifest: SyncManifest = {
      version: 1,
      records: [
        {
          targetId: 'test-repo',
          lastCommit: 'def456',
          lastSyncedAt: '2026-02-01T00:00:00.000Z',
          syncedFiles: ['lib/bar.ts'],
        },
      ],
    };
    saveManifest(MANIFEST_PATH, manifest);
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    expect(loaded.records[0].lastCommit).toBe('def456');
  });
});

describe('getHeadCommit', () => {
  it('returns trimmed commit SHA from git rev-parse', () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: 'abc123def456\n',
      stderr: '',
    });
    const sha = getHeadCommit('/tmp/some-clone');
    expect(sha).toBe('abc123def456');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'git',
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: '/tmp/some-clone' }),
    );
  });

  it('throws on git failure', () => {
    spawnSyncMock.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    expect(() => getHeadCommit('/tmp/bad')).toThrow();
  });
});

describe('cloneRepo', () => {
  it('calls git clone with --depth=1 and correct branch', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    cloneRepo('https://github.com/example/repo', 'develop', '/tmp/clone-dest');
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        '--depth=1',
        '--branch',
        'develop',
        'https://github.com/example/repo',
        '/tmp/clone-dest',
      ],
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it('throws on clone failure', () => {
    spawnSyncMock.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: repository not found',
    });
    expect(() => cloneRepo('https://github.com/example/bad', 'main', '/tmp/bad')).toThrow(
      /clone failed/i,
    );
  });
});

describe('syncTarget', () => {
  it('performs first-time sync: clones, copies files, returns changed=true', () => {
    // Set up: mock clone to create a temp dir with files
    const cloneDir = '/tmp/agendo-sync-test/clone-mock';
    const srcDir = path.join(cloneDir, 'src', 'lib');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'utils.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export * from "./utils";');

    // Mock git clone to be a no-op (we pre-created the dir)
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'clone') {
        // Copy our mock source to the clone target path
        const destPath = args[args.length - 1];
        fs.cpSync(cloneDir, destPath, { recursive: true });
        // Create .git dir so rev-parse works
        fs.mkdirSync(path.join(destPath, '.git'), { recursive: true });
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: 'aaa111bbb222\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = syncTarget(TEST_TARGET, MANIFEST_PATH);

    expect(result.changed).toBe(true);
    expect(result.commit).toBe('aaa111bbb222');
    expect(result.previousCommit).toBeNull();
    expect(result.files.length).toBeGreaterThanOrEqual(2);
    expect(result.files.some((f) => f.relativePath === 'utils.ts' && f.action === 'added')).toBe(
      true,
    );
    expect(result.files.some((f) => f.relativePath === 'index.ts' && f.action === 'added')).toBe(
      true,
    );

    // Verify files were actually copied to destination
    expect(fs.existsSync(path.join(TEST_TARGET.mappings[0].dest, 'utils.ts'))).toBe(true);
    expect(fs.existsSync(path.join(TEST_TARGET.mappings[0].dest, 'index.ts'))).toBe(true);
  });

  it('skips sync when upstream commit matches manifest (no changes)', () => {
    // Pre-populate manifest with current commit
    const manifest: SyncManifest = {
      version: 1,
      records: [
        {
          targetId: 'test-repo',
          lastCommit: 'same-commit',
          lastSyncedAt: '2026-01-01T00:00:00.000Z',
          syncedFiles: ['utils.ts'],
        },
      ],
    };
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));

    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'clone') {
        const destPath = args[args.length - 1];
        fs.mkdirSync(path.join(destPath, '.git'), { recursive: true });
        fs.mkdirSync(path.join(destPath, 'src', 'lib'), { recursive: true });
        fs.writeFileSync(path.join(destPath, 'src', 'lib', 'utils.ts'), 'unchanged');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: 'same-commit\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = syncTarget(TEST_TARGET, MANIFEST_PATH);
    expect(result.changed).toBe(false);
    expect(result.commit).toBe('same-commit');
  });

  it('detects updated and removed files on subsequent sync', () => {
    // Set up: manifest says we previously synced utils.ts and old-file.ts
    const manifest: SyncManifest = {
      version: 1,
      records: [
        {
          targetId: 'test-repo',
          lastCommit: 'old-commit',
          lastSyncedAt: '2026-01-01T00:00:00.000Z',
          syncedFiles: ['utils.ts', 'old-file.ts'],
        },
      ],
    };
    fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));

    // Create existing dest files
    const destDir = TEST_TARGET.mappings[0].dest;
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, 'utils.ts'), 'old content');
    fs.writeFileSync(path.join(destDir, 'old-file.ts'), 'will be removed');

    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'clone') {
        const clonePath = args[args.length - 1];
        fs.mkdirSync(path.join(clonePath, '.git'), { recursive: true });
        const srcPath = path.join(clonePath, 'src', 'lib');
        fs.mkdirSync(srcPath, { recursive: true });
        // utils.ts updated, old-file.ts removed, new-file.ts added
        fs.writeFileSync(path.join(srcPath, 'utils.ts'), 'new content');
        fs.writeFileSync(path.join(srcPath, 'new-file.ts'), 'brand new');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'rev-parse') {
        return { status: 0, stdout: 'new-commit\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    });

    const result = syncTarget(TEST_TARGET, MANIFEST_PATH);
    expect(result.changed).toBe(true);
    expect(result.previousCommit).toBe('old-commit');
    expect(result.commit).toBe('new-commit');

    // Check file actions
    const actions = Object.fromEntries(result.files.map((f) => [f.relativePath, f.action]));
    expect(actions['utils.ts']).toBe('updated');
    expect(actions['new-file.ts']).toBe('added');
    expect(actions['old-file.ts']).toBe('removed');

    // old-file.ts should be deleted from dest
    expect(fs.existsSync(path.join(destDir, 'old-file.ts'))).toBe(false);
    // new-file.ts should exist
    expect(fs.existsSync(path.join(destDir, 'new-file.ts'))).toBe(true);
  });

  it('handles disabled targets gracefully', () => {
    const disabled = { ...TEST_TARGET, enabled: false };
    const result = syncTarget(disabled, MANIFEST_PATH);
    expect(result.changed).toBe(false);
    expect(result.files).toEqual([]);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('returns error result on clone failure without throwing', () => {
    spawnSyncMock.mockReturnValue({
      status: 128,
      stdout: '',
      stderr: 'fatal: repository not found',
    });

    const result = syncTarget(TEST_TARGET, MANIFEST_PATH);
    expect(result.changed).toBe(false);
    expect(result.error).toMatch(/clone failed/i);
  });
});
