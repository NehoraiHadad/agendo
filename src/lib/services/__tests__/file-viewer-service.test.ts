import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface FileViewerEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string;
  isImage: boolean;
  isVideo: boolean;
}

interface FileViewerResult {
  dir: string | null;
  parent: string | null;
  breadcrumbs: { label: string; path: string }[];
  entries: FileViewerEntry[];
  imageCount: number;
  allowedRoots: string[];
}

interface FileViewerServiceModule {
  listDirectory: (dir?: string) => Promise<FileViewerResult>;
  isPathAllowed: (resolvedPath: string) => boolean;
}

async function loadFileViewerService(allowedDirs: string[]): Promise<FileViewerServiceModule> {
  vi.resetModules();
  vi.doMock('@/lib/config', () => ({
    allowedWorkingDirs: allowedDirs,
  }));
  return import('../file-viewer-service') as Promise<FileViewerServiceModule>;
}

describe('file-viewer-service', () => {
  let tempRoot: string;
  let allowedRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'agendo-file-viewer-'));
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

  describe('listDirectory(undefined) — root picker', () => {
    it('returns null dir, no parent, allowedRoots, and no entries', async () => {
      const { listDirectory } = await loadFileViewerService([allowedRoot, outsideRoot]);

      const result = await listDirectory();

      expect(result.dir).toBeNull();
      expect(result.parent).toBeNull();
      expect(result.entries).toEqual([]);
      expect(result.breadcrumbs).toEqual([]);
      expect(result.imageCount).toBe(0);
      expect(result.allowedRoots).toEqual([allowedRoot, outsideRoot]);
    });
  });

  describe('listDirectory(dir) — directory listing', () => {
    it('rejects paths outside allowed roots with ForbiddenError', async () => {
      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      await expect(listDirectory(outsideRoot)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      });
    });

    it('rejects ENOENT with NotFoundError', async () => {
      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      const missing = path.join(allowedRoot, 'does-not-exist');
      await expect(listDirectory(missing)).rejects.toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
      });
    });

    it('rejects a file path with ValidationError', async () => {
      const filePath = path.join(allowedRoot, 'a-file.txt');
      await writeFile(filePath, 'hi');
      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      await expect(listDirectory(filePath)).rejects.toMatchObject({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
      });
    });

    it('lists entries with directories first, then alphabetical', async () => {
      await mkdir(path.join(allowedRoot, 'beta'), { recursive: true });
      await mkdir(path.join(allowedRoot, 'alpha'), { recursive: true });
      await writeFile(path.join(allowedRoot, 'zeta.txt'), 'hi');
      await writeFile(path.join(allowedRoot, 'apple.md'), 'hi');

      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      const result = await listDirectory(allowedRoot);

      expect(result.entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'apple.md', 'zeta.txt']);
      expect(result.entries[0].isDir).toBe(true);
      expect(result.entries[1].isDir).toBe(true);
      expect(result.entries[2].isDir).toBe(false);
    });

    it('flags images and videos by extension', async () => {
      await writeFile(path.join(allowedRoot, 'pic.PNG'), 'fake');
      await writeFile(path.join(allowedRoot, 'clip.mp4'), 'fake');
      await writeFile(path.join(allowedRoot, 'note.txt'), 'fake');

      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      const result = await listDirectory(allowedRoot);

      const pic = result.entries.find((e) => e.name === 'pic.PNG')!;
      const clip = result.entries.find((e) => e.name === 'clip.mp4')!;
      const note = result.entries.find((e) => e.name === 'note.txt')!;

      expect(pic.isImage).toBe(true);
      expect(pic.isVideo).toBe(false);
      expect(clip.isImage).toBe(false);
      expect(clip.isVideo).toBe(true);
      expect(note.isImage).toBe(false);
      expect(note.isVideo).toBe(false);
      expect(result.imageCount).toBe(1);
    });

    it('returns size in bytes and modified as ISO string', async () => {
      const filePath = path.join(allowedRoot, 'doc.txt');
      await writeFile(filePath, 'hello world'); // 11 bytes
      const knownTime = new Date('2026-01-15T10:30:00.000Z');
      await utimes(filePath, knownTime, knownTime);

      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      const result = await listDirectory(allowedRoot);

      const doc = result.entries.find((e) => e.name === 'doc.txt')!;
      expect(doc.size).toBe(11);
      expect(doc.modified).toBe(knownTime.toISOString());
    });

    it('builds breadcrumbs from path segments anchored at the allowed root', async () => {
      const nested = path.join(allowedRoot, 'inner', 'deep');
      await mkdir(nested, { recursive: true });

      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      const result = await listDirectory(nested);

      // breadcrumbs include each directory up to the dir, with absolute paths
      expect(result.breadcrumbs.length).toBeGreaterThanOrEqual(2);
      const labels = result.breadcrumbs.map((b) => b.label);
      expect(labels).toContain('inner');
      expect(labels).toContain('deep');
      // last breadcrumb path equals dir
      expect(result.breadcrumbs[result.breadcrumbs.length - 1].path).toBe(nested);
    });

    it('returns parent when parent is still inside an allowed root', async () => {
      const nested = path.join(allowedRoot, 'sub');
      await mkdir(nested, { recursive: true });

      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      const result = await listDirectory(nested);

      expect(result.parent).toBe(allowedRoot);
    });

    it('returns null parent when at the allowed root itself', async () => {
      const { listDirectory } = await loadFileViewerService([allowedRoot]);
      const result = await listDirectory(allowedRoot);
      expect(result.parent).toBeNull();
    });
  });

  describe('isPathAllowed', () => {
    it('returns true for the root itself and any descendant', async () => {
      const { isPathAllowed } = await loadFileViewerService([allowedRoot]);
      expect(isPathAllowed(allowedRoot)).toBe(true);
      expect(isPathAllowed(path.join(allowedRoot, 'sub'))).toBe(true);
      expect(isPathAllowed(path.join(allowedRoot, 'sub', 'leaf.txt'))).toBe(true);
    });

    it('returns false for paths outside roots and lookalike prefixes', async () => {
      const { isPathAllowed } = await loadFileViewerService([allowedRoot]);
      expect(isPathAllowed(outsideRoot)).toBe(false);
      // prevent prefix match: /tmp/allowed-evil should not match /tmp/allowed
      expect(isPathAllowed(`${allowedRoot}-evil`)).toBe(false);
    });
  });
});
