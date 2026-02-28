import * as fs from 'node:fs';
import * as path from 'node:path';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { ForbiddenError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

export type ConfigScope = 'global' | { projectPath: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File extensions allowed in the config tree. */
const ALLOWED_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolves `~` in a path to the user's home directory.
 * Returns the path unchanged if it does not start with `~`.
 */
function expandHome(filePath: string): string {
  const home = process.env.HOME ?? '/root';
  if (filePath === '~') return home;
  if (filePath.startsWith('~/')) return path.join(home, filePath.slice(2));
  return filePath;
}

/**
 * Returns the absolute path of the `~/.claude` directory.
 */
function globalClaudeDir(): string {
  return expandHome('~/.claude');
}

/**
 * Fetches all known project rootPath values from the database so we can
 * validate that a requested projectPath is a registered project root.
 */
async function fetchProjectRoots(): Promise<string[]> {
  const rows = await db.select({ rootPath: projects.rootPath }).from(projects);
  return rows.map((r) => path.resolve(r.rootPath));
}

/**
 * Returns true when `filePath` is permitted by the security whitelist.
 *
 * Allowed locations:
 *  - `~/.claude/` (any file underneath)
 *  - `<projectRoot>/CLAUDE.md`
 *  - `<projectRoot>/.claude/` (any file underneath)
 *
 * The function resolves the real path (collapsing `..` etc.) before
 * comparing, which prevents path-traversal attacks.
 */
async function isPathAllowed(filePath: string): Promise<boolean> {
  const resolved = path.resolve(expandHome(filePath));

  // 1. Check global Claude directory
  const globalDir = path.resolve(globalClaudeDir());
  if (resolved.startsWith(globalDir + path.sep) || resolved === globalDir) {
    return true;
  }

  // 2. Check project-scoped paths
  const roots = await fetchProjectRoots();
  for (const root of roots) {
    // <projectRoot>/CLAUDE.md
    const claudeMd = path.join(root, 'CLAUDE.md');
    if (resolved === claudeMd) return true;

    // <projectRoot>/.claude/**
    const dotClaude = path.join(root, '.claude');
    if (resolved.startsWith(dotClaude + path.sep) || resolved === dotClaude) {
      return true;
    }
  }

  return false;
}

/**
 * Asserts that a path is on the whitelist, throwing `ForbiddenError` otherwise.
 */
async function assertPathAllowed(filePath: string): Promise<void> {
  const allowed = await isPathAllowed(filePath);
  if (!allowed) {
    throw new ForbiddenError('Access to the requested file path is not permitted', {
      path: filePath,
    });
  }
}

/**
 * Recursively builds a `TreeNode[]` for the given directory.
 * Only includes files whose extension is in `ALLOWED_EXTENSIONS`.
 */
function buildTree(dirPath: string): TreeNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    // Directory may not exist yet — return empty list rather than crashing.
    return [];
  }

  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const children = buildTree(fullPath);
      // Include directory nodes even if currently empty (the directory itself
      // might be meaningful to the user, e.g. `commands/` or `hooks/`).
      nodes.push({
        path: fullPath,
        name: entry.name,
        isDirectory: true,
        children,
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) {
        nodes.push({ path: fullPath, name: entry.name, isDirectory: false });
      }
    }
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Public service functions
// ---------------------------------------------------------------------------

/**
 * Returns the file/directory tree for a given config scope.
 *
 * - `'global'`: scans `~/.claude/`
 * - `{ projectPath }`: scans `<projectPath>/.claude/` and includes
 *   `<projectPath>/CLAUDE.md` when it exists.
 */
export async function getConfigTree(scope: ConfigScope): Promise<TreeNode[]> {
  if (scope === 'global') {
    const dir = globalClaudeDir();
    return buildTree(dir);
  }

  const { projectPath } = scope;
  const nodes: TreeNode[] = [];

  // Include <projectRoot>/CLAUDE.md if it exists
  const claudeMd = path.join(projectPath, 'CLAUDE.md');
  if (fs.existsSync(claudeMd)) {
    nodes.push({ path: claudeMd, name: 'CLAUDE.md', isDirectory: false });
  }

  // Include contents of <projectRoot>/.claude/
  const dotClaude = path.join(projectPath, '.claude');
  const dotClaudeChildren = buildTree(dotClaude);
  if (dotClaudeChildren.length > 0 || fs.existsSync(dotClaude)) {
    nodes.push({
      path: dotClaude,
      name: '.claude',
      isDirectory: true,
      children: dotClaudeChildren,
    });
  }

  return nodes;
}

/**
 * Reads a config file and returns its content.
 * Throws `ForbiddenError` if the path is not on the whitelist.
 */
export async function readConfigFile(filePath: string): Promise<{ content: string; path: string }> {
  await assertPathAllowed(filePath);
  const resolved = path.resolve(expandHome(filePath));
  const content = fs.readFileSync(resolved, 'utf-8');
  return { content, path: resolved };
}

/**
 * Writes content to a config file, creating parent directories as needed.
 * Throws `ForbiddenError` if the path is not on the whitelist.
 */
export async function writeConfigFile(filePath: string, content: string): Promise<void> {
  await assertPathAllowed(filePath);
  const resolved = path.resolve(expandHome(filePath));
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, 'utf-8');
}
