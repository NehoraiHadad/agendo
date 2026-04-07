import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { allowedWorkingDirs } from '@/lib/config';
import { ValidationError } from '@/lib/errors';

export type ProjectType = 'git' | 'node' | 'python' | 'rust' | 'go' | 'other';

export interface DiscoveredProject {
  path: string;
  name: string;
  type: ProjectType;
}

export interface BrowsedDirectory {
  path: string;
  name: string;
  type: ProjectType;
  isProjectLike: boolean;
}

export interface BrowseProjectDirectoriesResult {
  currentPath: string | null;
  parentPath: string | null;
  roots: string[];
  entries: BrowsedDirectory[];
}

export interface ProjectPathStatus {
  status: 'exists' | 'creatable' | 'denied';
  normalizedPath: string;
  reason?: string;
}

const PROJECT_INDICATORS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
] as const;

/** Directory names that are never themselves projects or useful browse targets. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'output',
  'coverage',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vercel',
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'vendor',
  '.gradle',
  '.mvn',
  'tmp',
  'temp',
  '.tmp',
]);

function getConfiguredRoots(): string[] {
  return [...new Set(allowedWorkingDirs.map((dir) => resolve(dir)))];
}

async function getPolicyRoots(): Promise<string[]> {
  const resolvedRoots = await Promise.all(
    getConfiguredRoots().map(async (dir) => {
      try {
        return await realpath(dir);
      } catch {
        return dir;
      }
    }),
  );
  return [...new Set(resolvedRoots)];
}

function isPathWithinRoots(candidatePath: string, roots: string[]): boolean {
  return roots.some((root) => candidatePath === root || candidatePath.startsWith(root + sep));
}

async function detectProjectType(dirPath: string): Promise<ProjectType | null> {
  for (const indicator of PROJECT_INDICATORS) {
    try {
      await access(join(dirPath, indicator));
      if (indicator === '.git') return 'git';
      if (indicator === 'package.json') return 'node';
      if (indicator === 'pyproject.toml') return 'python';
      if (indicator === 'go.mod') return 'go';
      if (indicator === 'Cargo.toml') return 'rust';
    } catch {
      // indicator not present
    }
  }
  return null;
}

async function findClosestExistingAncestor(targetPath: string): Promise<string | null> {
  let current = resolve(targetPath);

  while (true) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function resolvePathForPolicy(rawPath: string): Promise<string> {
  const normalized = resolve(rawPath);
  const existingAncestor = await findClosestExistingAncestor(normalized);
  if (!existingAncestor) return normalized;

  const realAncestor = await realpath(existingAncestor);
  const remainder = relative(existingAncestor, normalized);
  return remainder ? join(realAncestor, remainder) : realAncestor;
}

async function describeDirectoryEntry(dirPath: string): Promise<BrowsedDirectory> {
  const type = (await detectProjectType(dirPath)) ?? 'other';
  return {
    path: dirPath,
    name: basename(dirPath) || dirPath,
    type,
    isProjectLike: type !== 'other',
  };
}

function denied(normalizedPath: string, reason: string): ProjectPathStatus {
  return { status: 'denied', normalizedPath, reason };
}

export async function getProjectPathStatus(rawPath: string): Promise<ProjectPathStatus> {
  if (!rawPath) {
    return denied('', 'Path is required');
  }

  if (!rawPath.startsWith('/')) {
    return denied(resolve(rawPath), 'Path must be absolute');
  }

  const normalizedInputPath = resolve(rawPath);
  const normalizedPolicyPath = await resolvePathForPolicy(normalizedInputPath);
  const allowedRoots = await getPolicyRoots();

  if (!isPathWithinRoots(normalizedPolicyPath, allowedRoots)) {
    return denied(
      normalizedPolicyPath,
      `Path not under allowed directories: ${getConfiguredRoots().join(', ')}`,
    );
  }

  try {
    const stats = await stat(normalizedInputPath);
    if (!stats.isDirectory()) {
      return denied(normalizedPolicyPath, 'Path is a file, not a directory');
    }
    return { status: 'exists', normalizedPath: normalizedPolicyPath };
  } catch {
    const existingAncestor = await findClosestExistingAncestor(normalizedInputPath);
    if (!existingAncestor) {
      return denied(normalizedPolicyPath, 'No existing parent directory found');
    }

    try {
      await access(existingAncestor, constants.W_OK);
    } catch {
      return denied(normalizedPolicyPath, 'Parent directory is not writable');
    }

    return { status: 'creatable', normalizedPath: normalizedPolicyPath };
  }
}

export async function validateProjectPath(rawPath: string): Promise<string> {
  const status = await getProjectPathStatus(rawPath);
  if (status.status === 'denied') {
    throw new ValidationError(status.reason ?? 'Path not allowed');
  }
  return status.normalizedPath;
}

export async function browseProjectDirectories(
  rawPath?: string,
): Promise<BrowseProjectDirectoriesResult> {
  const roots = getConfiguredRoots();

  if (!rawPath) {
    return {
      currentPath: null,
      parentPath: null,
      roots,
      entries: await Promise.all(roots.map((dir) => describeDirectoryEntry(dir))),
    };
  }

  const pathStatus = await getProjectPathStatus(rawPath);
  if (pathStatus.status !== 'exists') {
    throw new ValidationError(pathStatus.reason ?? 'Directory does not exist');
  }

  const currentPath = pathStatus.normalizedPath;
  const entries = await readdir(currentPath, { withFileTypes: true });
  const childDirectories: BrowsedDirectory[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

    const candidatePath = join(currentPath, entry.name);
    const candidateStatus = await getProjectPathStatus(candidatePath);
    if (candidateStatus.status !== 'exists') continue;

    childDirectories.push(await describeDirectoryEntry(candidateStatus.normalizedPath));
  }

  childDirectories.sort((a, b) => {
    if (a.isProjectLike !== b.isProjectLike) return a.isProjectLike ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parentCandidate = dirname(currentPath);
  const parentPath =
    parentCandidate !== currentPath &&
    (await getProjectPathStatus(parentCandidate)).status === 'exists'
      ? parentCandidate
      : null;

  return {
    currentPath,
    parentPath,
    roots,
    entries: childDirectories,
  };
}

export async function discoverProjectDirectories(): Promise<DiscoveredProject[]> {
  const roots = getConfiguredRoots();
  const discovered: DiscoveredProject[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const rootType = await detectProjectType(root);
    if (rootType !== null && !seen.has(root)) {
      seen.add(root);
      discovered.push({ path: root, name: basename(root) || root, type: rootType });
    }

    const browsingResult = await browseProjectDirectories(root).catch(() => null);
    if (!browsingResult) continue;

    for (const entry of browsingResult.entries) {
      if (!entry.isProjectLike || seen.has(entry.path)) continue;
      seen.add(entry.path);
      discovered.push({
        path: entry.path,
        name: entry.name,
        type: entry.type,
      });
    }
  }

  return discovered;
}
