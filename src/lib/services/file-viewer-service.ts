import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { allowedWorkingDirs } from '@/lib/config';
import { ForbiddenError, NotFoundError, ValidationError } from '@/lib/errors';

const IMAGE_EXTS = new Set([
  '.webp',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.bmp',
  '.avif',
  '.ico',
]);

const VIDEO_EXTS = new Set(['.mp4', '.webm']);

export interface FileViewerEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string;
  isImage: boolean;
  isVideo: boolean;
}

export interface FileViewerBreadcrumb {
  label: string;
  path: string;
}

export interface FileViewerResult {
  /** Absolute directory path being listed, or null when no `dir` was given (root picker). */
  dir: string | null;
  /** Absolute parent directory path, or null when at an allowed root or no `dir`. */
  parent: string | null;
  /** Path segments from the closest allowed root (inclusive) down to `dir`. Empty when `dir` is null. */
  breadcrumbs: FileViewerBreadcrumb[];
  /** Directory entries: directories first, then files, alphabetical within each group. */
  entries: FileViewerEntry[];
  /** Quick count of entries flagged isImage. */
  imageCount: number;
  /** Configured allowed roots (absolute, normalized). */
  allowedRoots: string[];
}

function getAllowedRoots(): string[] {
  return [...new Set(allowedWorkingDirs.map((dir) => resolve(dir)))];
}

/** Pure: true when `resolvedPath` is one of the allowed roots or lives strictly under one. */
export function isPathAllowed(resolvedPath: string): boolean {
  return getAllowedRoots().some(
    (root) => resolvedPath === root || resolvedPath.startsWith(root + sep),
  );
}

function findOwningRoot(resolvedPath: string): string | null {
  return (
    getAllowedRoots().find(
      (root) => resolvedPath === root || resolvedPath.startsWith(root + sep),
    ) ?? null
  );
}

function buildBreadcrumbs(dir: string): FileViewerBreadcrumb[] {
  const owningRoot = findOwningRoot(dir);
  if (!owningRoot) return [];

  const crumbs: FileViewerBreadcrumb[] = [
    { label: basename(owningRoot) || owningRoot, path: owningRoot },
  ];
  if (dir === owningRoot) return crumbs;

  const remainder = dir.slice(owningRoot.length + 1); // strip "<root>/"
  const segments = remainder.split(sep).filter(Boolean);

  let acc = owningRoot;
  for (const segment of segments) {
    acc = join(acc, segment);
    crumbs.push({ label: segment, path: acc });
  }
  return crumbs;
}

async function readEntries(dir: string): Promise<FileViewerEntry[]> {
  const names = await readdir(dir);
  const entries: FileViewerEntry[] = [];

  await Promise.all(
    names.map(async (name) => {
      try {
        const fullPath = join(dir, name);
        const s = await stat(fullPath);
        const ext = extname(name).toLowerCase();
        entries.push({
          name,
          path: fullPath,
          isDir: s.isDirectory(),
          size: s.size,
          modified: s.mtime.toISOString(),
          isImage: IMAGE_EXTS.has(ext),
          isVideo: VIDEO_EXTS.has(ext),
        });
      } catch {
        // Skip entries we can't stat (broken symlinks, permission errors)
      }
    }),
  );

  // Directories first, then alphabetical (case-insensitive)
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

/**
 * List a directory under one of the allowed roots.
 *
 * - When called with no `rawDir`, returns a "root picker" payload: `dir=null`, `entries=[]`,
 *   and the configured `allowedRoots`. The client renders these as the landing cards.
 * - When called with a `rawDir`:
 *   - {@link ForbiddenError} if the resolved path is not under any allowed root.
 *   - {@link NotFoundError} if the directory does not exist (ENOENT).
 *   - {@link ValidationError} if the path resolves to a file rather than a directory.
 *   - Otherwise returns full entries, breadcrumbs, parent (if still in roots), and image count.
 */
export async function listDirectory(rawDir?: string): Promise<FileViewerResult> {
  const allowedRoots = getAllowedRoots();

  if (!rawDir) {
    return {
      dir: null,
      parent: null,
      breadcrumbs: [],
      entries: [],
      imageCount: 0,
      allowedRoots,
    };
  }

  const resolved = resolve(rawDir);

  if (!isPathAllowed(resolved)) {
    throw new ForbiddenError('Path not allowed', { path: resolved, allowedRoots });
  }

  let dirStat;
  try {
    dirStat = await stat(resolved);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NotFoundError('Directory', resolved);
    }
    throw err;
  }

  if (!dirStat.isDirectory()) {
    throw new ValidationError('Path is not a directory', { path: resolved });
  }

  const entries = await readEntries(resolved);
  const owningRoot = findOwningRoot(resolved);
  const parentCandidate = dirname(resolved);
  const parent =
    owningRoot && resolved !== owningRoot && isPathAllowed(parentCandidate)
      ? parentCandidate
      : null;

  return {
    dir: resolved,
    parent,
    breadcrumbs: buildBreadcrumbs(resolved),
    entries,
    imageCount: entries.filter((e) => e.isImage).length,
    allowedRoots,
  };
}
