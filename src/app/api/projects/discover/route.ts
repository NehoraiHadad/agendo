import { readdir, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { allowedWorkingDirs } from '@/lib/config';
import { listProjects } from '@/lib/services/project-service';

type ProjectType = 'git' | 'node' | 'python' | 'rust' | 'go' | 'other';

interface DiscoveredProject {
  path: string;
  name: string;
  type: ProjectType;
}

const PROJECT_INDICATORS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'] as const;

/** Directory names that are never themselves projects, even if they contain indicator files. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit',
  'dist', 'build', 'out', 'output', 'coverage',
  '.cache', '.parcel-cache', '.turbo', '.vercel',
  'venv', '.venv', 'env', '.env',
  '__pycache__', '.tox', '.pytest_cache', '.mypy_cache',
  'target', 'vendor', '.gradle', '.mvn',
  'tmp', 'temp', '.tmp',
]);

async function detectProjectType(dirPath: string): Promise<ProjectType | null> {
  for (const indicator of PROJECT_INDICATORS) {
    try {
      await access(path.join(dirPath, indicator));
      if (indicator === '.git') return 'git';
      if (indicator === 'package.json') return 'node';
      if (indicator === 'pyproject.toml') return 'python';
      if (indicator === 'go.mod') return 'go';
      if (indicator === 'Cargo.toml') return 'rust';
    } catch {
      // indicator not present — continue
    }
  }
  return null;
}

async function scanDirectory(dirPath: string): Promise<string[]> {
  const projectPaths: string[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      // Skip known non-project directories and hidden dirs (e.g. .cache, .local)
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry.name);

      try {
        const stats = await stat(fullPath);
        if (!stats.isDirectory()) continue;

        const type = await detectProjectType(fullPath);
        if (type !== null) {
          projectPaths.push(fullPath);
        }
      } catch {
        // stat failed or access denied — skip
      }
    }
  } catch {
    // readdir failed — skip
  }

  return projectPaths;
}

export const GET = withErrorBoundary(async (_req: NextRequest) => {
  const extraRoots = ['/home/ubuntu', '/home/ubuntu/projects'];
  const searchRoots = [...new Set([...allowedWorkingDirs, ...extraRoots])];

  const existingProjects = await listProjects();
  const registeredPaths = new Set(existingProjects.map((p) => p.rootPath));

  const discovered: DiscoveredProject[] = [];
  const seen = new Set<string>();

  for (const root of searchRoots) {
    // Depth 1: check root itself
    const rootType = await detectProjectType(root);
    if (rootType !== null && !registeredPaths.has(root) && !seen.has(root)) {
      seen.add(root);
      discovered.push({ path: root, name: path.basename(root), type: rootType });
    }

    // Depth 2: scan subdirectories of root
    const subPaths = await scanDirectory(root);
    for (const subPath of subPaths) {
      if (registeredPaths.has(subPath) || seen.has(subPath)) continue;
      seen.add(subPath);

      const type = await detectProjectType(subPath);
      if (type !== null) {
        discovered.push({ path: subPath, name: path.basename(subPath), type });
      }
    }
  }

  return NextResponse.json({ data: discovered });
});
