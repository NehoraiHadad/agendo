import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface ProjectPathServiceModule {
  browseProjectDirectories: (rawPath?: string) => Promise<{
    currentPath: string | null;
    parentPath: string | null;
    roots: string[];
    entries: Array<{
      path: string;
      name: string;
      type: 'git' | 'node' | 'python' | 'rust' | 'go' | 'other';
      isProjectLike: boolean;
    }>;
  }>;
  discoverProjectDirectories: () => Promise<
    Array<{
      path: string;
      name: string;
      type: 'git' | 'node' | 'python' | 'rust' | 'go' | 'other';
    }>
  >;
  getProjectPathStatus: (rawPath: string) => Promise<{
    status: 'exists' | 'creatable' | 'denied';
    normalizedPath: string;
    reason?: string;
  }>;
  validateProjectPath: (rawPath: string) => Promise<string>;
}

async function loadProjectPathService(allowedDirs: string[]): Promise<ProjectPathServiceModule> {
  vi.resetModules();
  vi.doMock('@/lib/config', () => ({
    allowedWorkingDirs: allowedDirs,
  }));
  return import('../project-path-service') as Promise<ProjectPathServiceModule>;
}

describe('project-path-service', () => {
  let tempRoot: string;
  let allowedRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agendo-project-paths-'));
    allowedRoot = path.join(tempRoot, 'allowed');
    outsideRoot = path.join(tempRoot, 'outside');

    await mkdir(allowedRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
  });

  afterEach(async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/config');
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('returns exists only for directories inside allowed roots', async () => {
    const insideDir = path.join(allowedRoot, 'plain-dir');
    const outsideDir = path.join(outsideRoot, 'secret-dir');
    await mkdir(insideDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });

    const { getProjectPathStatus } = await loadProjectPathService([allowedRoot]);

    await expect(getProjectPathStatus(insideDir)).resolves.toMatchObject({
      status: 'exists',
      normalizedPath: insideDir,
    });
    await expect(getProjectPathStatus(outsideDir)).resolves.toMatchObject({
      status: 'denied',
    });
  });

  it('blocks symlink escapes even when the entered path starts under an allowed root', async () => {
    const escapedDir = path.join(outsideRoot, 'real-project');
    const symlinkPath = path.join(allowedRoot, 'linked-project');
    await mkdir(escapedDir, { recursive: true });
    await symlink(escapedDir, symlinkPath, 'dir');

    const { getProjectPathStatus, validateProjectPath } = await loadProjectPathService([
      allowedRoot,
    ]);

    await expect(getProjectPathStatus(symlinkPath)).resolves.toMatchObject({
      status: 'denied',
    });
    await expect(validateProjectPath(symlinkPath)).rejects.toThrow(/allowed/i);
  });

  it('returns creatable for a missing path under an allowed root', async () => {
    const targetPath = path.join(allowedRoot, 'new-project');
    const { getProjectPathStatus } = await loadProjectPathService([allowedRoot]);

    await expect(getProjectPathStatus(targetPath)).resolves.toMatchObject({
      status: 'creatable',
      normalizedPath: targetPath,
    });
  });

  it('browses plain directories and tags project-like children without requiring git', async () => {
    const plainDir = path.join(allowedRoot, 'notes');
    const nodeDir = path.join(allowedRoot, 'web-app');
    const nestedDir = path.join(nodeDir, 'src');
    await mkdir(plainDir, { recursive: true });
    await mkdir(nestedDir, { recursive: true });
    await writeFile(path.join(nodeDir, 'package.json'), '{"name":"web-app"}');

    const { browseProjectDirectories } = await loadProjectPathService([allowedRoot]);

    const rootListing = await browseProjectDirectories(allowedRoot);
    expect(rootListing.currentPath).toBe(allowedRoot);
    expect(rootListing.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: plainDir,
          name: 'notes',
          type: 'other',
          isProjectLike: false,
        }),
        expect.objectContaining({
          path: nodeDir,
          name: 'web-app',
          type: 'node',
          isProjectLike: true,
        }),
      ]),
    );

    const nestedListing = await browseProjectDirectories(nodeDir);
    expect(nestedListing.parentPath).toBe(allowedRoot);
    expect(nestedListing.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: nestedDir,
          name: 'src',
          type: 'other',
          isProjectLike: false,
        }),
      ]),
    );
  });

  it('keeps discover focused on project-like directories only', async () => {
    const plainDir = path.join(allowedRoot, 'documents');
    const gitDir = path.join(allowedRoot, 'repo');
    await mkdir(plainDir, { recursive: true });
    await mkdir(path.join(gitDir, '.git'), { recursive: true });

    const { discoverProjectDirectories } = await loadProjectPathService([allowedRoot]);

    const discovered = await discoverProjectDirectories();
    expect(discovered).toEqual([
      expect.objectContaining({
        path: gitDir,
        name: 'repo',
        type: 'git',
      }),
    ]);
  });
});
