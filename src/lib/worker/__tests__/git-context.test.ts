import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { captureGitContext } from '../git-context';

describe('captureGitContext', () => {
  let repoDir: string;

  beforeAll(() => {
    // Create a temp git repo with hardcoded safe commands (no user input)
    repoDir = mkdtempSync(join(tmpdir(), 'git-context-test-'));
    execSync('git init', { cwd: repoDir });
    execSync('git config user.email "test@test.com"', { cwd: repoDir });
    execSync('git config user.name "Test User"', { cwd: repoDir });
    writeFileSync(join(repoDir, 'file.txt'), 'hello');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "initial commit"', { cwd: repoDir });
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns non-null for a git repo with correct branch and hash', async () => {
    const result = await captureGitContext(repoDir);

    expect(result).not.toBeNull();
    expect(result!.branch).toBe('master');
    expect(result!.commitHash).toMatch(/^[0-9a-f]{7,}$/);
    expect(result!.commitMessage).toBe('initial commit');
    expect(result!.isDirty).toBe(false);
    expect(result!.staged).toEqual([]);
    expect(result!.modified).toEqual([]);
    expect(result!.untracked).toEqual([]);
    expect(result!.isWorktree).toBe(false);
    // No upstream in a local-only repo
    expect(result!.baseBranch).toBeUndefined();
    expect(result!.aheadBehind).toBeUndefined();
  });

  it('returns null for a non-git directory', async () => {
    // Use a fresh temp dir with no git init
    const nonGitDir = mkdtempSync(join(tmpdir(), 'no-git-'));
    try {
      const result = await captureGitContext(nonGitDir);
      expect(result).toBeNull();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('detects isDirty with untracked files', async () => {
    writeFileSync(join(repoDir, 'new-file.txt'), 'dirty');

    const result = await captureGitContext(repoDir);

    expect(result).not.toBeNull();
    expect(result!.isDirty).toBe(true);
    expect(result!.untracked).toContain('new-file.txt');

    // Clean up for next test
    execSync('git add new-file.txt', { cwd: repoDir });
    execSync('git commit -m "add new file"', { cwd: repoDir });
  });

  it('detects modified and staged files', async () => {
    // Force a different mtime by touching with a delay via git
    writeFileSync(join(repoDir, 'file.txt'), 'modified-content');

    const result = await captureGitContext(repoDir);
    expect(result).not.toBeNull();
    expect(result!.isDirty).toBe(true);
    expect(result!.modified).toContain('file.txt');

    // Stage the modification
    execSync('git add file.txt', { cwd: repoDir });

    const result2 = await captureGitContext(repoDir);
    expect(result2).not.toBeNull();
    expect(result2!.staged).toContain('file.txt');
  });
});
