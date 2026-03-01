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
  /**
   * Tokens loaded on every message.
   * - For most files (CLAUDE.md, MEMORY.md, settings.json…): full file content.
   * - For skills/ and commands/ files: frontmatter only (~100 tokens typical).
   * - For directories: sum of all descendant always-loaded tokens.
   */
  tokenEstimate?: number;
  /**
   * Body tokens loaded only when the skill/command is explicitly invoked.
   * Only present for files inside skills/ or commands/ directories.
   */
  invokeTokenEstimate?: number;
  children?: TreeNode[];
}

export type ConfigScope = 'global' | { projectPath: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** File extensions allowed in the config tree. */
const ALLOWED_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml']);

/**
 * Directory names that contain Claude Code internal state rather than
 * user-editable configuration. These are excluded from the tree entirely
 * to keep the editor focused and to avoid inflated token counts.
 *
 * What IS included: root-level files, skills/, commands/, agents/, hooks/
 * What is NOT included: caches, logs, runtime state, marketplace plugins,
 *   per-project auto-generated memory, task/team state from agendo, etc.
 */
const EXCLUDED_DIRS = new Set([
  'backups', // backup copies of config files
  'cache', // internal caches
  'debug', // debug logs
  'file-history', // file edit history
  'ide', // IDE integration state
  'mcp-needs-auth-cache', // MCP auth cache
  'paste-cache', // clipboard history
  'plugins', // marketplace plugins (installed separately, not user config)
  'projects', // per-project auto-generated memory and conversation state
  'plans', // planning files (agendo / internal)
  'scripts', // utility scripts, not context-loaded
  'session-env', // per-session environment snapshots
  'shell-snapshots', // shell state snapshots
  'statsig', // telemetry / feature flags
  'tasks', // agendo task state
  'teams', // agendo team state
  'telemetry', // telemetry data
  'todos', // claude code todo state
]);

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

/** Sums the always-loaded tokenEstimate across a flat list of nodes (directories already carry their subtotal). */
function sumNodeTokens(nodes: TreeNode[]): number {
  return nodes.reduce((acc, n) => acc + (n.tokenEstimate ?? 0), 0);
}

/**
 * Returns true when any ancestor directory of the file is `skills` or `commands`.
 *
 * This handles:
 * - commands/amend.md (parent = commands) ✓
 * - skills/architect-mind/SKILL.md (ancestor = skills) ✓
 * - skills/aws-cli-expert/references/guide.md (ancestor = skills) ✓
 *
 * For these files only the YAML frontmatter is shown in the skills/commands list
 * per message; the full body loads only when the skill/command is invoked.
 * Reference files have no frontmatter, so their always-loaded portion is ~0 tokens.
 */
function isInvokeOnlyFile(filePath: string): boolean {
  return filePath.split(path.sep).some((part) => part === 'skills' || part === 'commands');
}

/**
 * Returns true for files that are never injected into Claude's context window.
 * README.md files are documentation shipped with skills/plugins, not user config.
 */
function isNonContextFile(fileName: string): boolean {
  return fileName === 'README.md';
}

/**
 * Extracts the frontmatter block (content between the first `---` pair) from a markdown file.
 * Returns an empty string if the file does not begin with a frontmatter block.
 */
function extractFrontmatter(content: string): string {
  if (!content.startsWith('---')) return '';
  const endIdx = content.indexOf('\n---', 3);
  return endIdx === -1 ? '' : content.slice(0, endIdx + 4);
}

/**
 * Recursively builds a `TreeNode[]` for the given directory.
 * Only includes files whose extension is in `ALLOWED_EXTENSIONS`.
 *
 * Token estimation (chars / 4):
 * - Regular files: full content → tokenEstimate (always loaded).
 * - skills/ and commands/ files: frontmatter → tokenEstimate (always loaded),
 *   body → invokeTokenEstimate (loaded only on invocation).
 * - Directories: sum of descendant tokenEstimate values.
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
      if (EXCLUDED_DIRS.has(entry.name)) continue; // internal state — not user config
      const children = buildTree(fullPath);
      const tokenEstimate = sumNodeTokens(children);
      // Include directory nodes even if currently empty (the directory itself
      // might be meaningful to the user, e.g. `commands/` or `hooks/`).
      nodes.push({
        path: fullPath,
        name: entry.name,
        isDirectory: true,
        tokenEstimate: tokenEstimate > 0 ? tokenEstimate : undefined,
        children,
      });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.has(ext)) {
        let tokenEstimate: number | undefined;
        let invokeTokenEstimate: number | undefined;
        // Only .md files are injected as raw text into Claude's context window.
        // JSON/YAML files are configuration data (settings, keybindings, internal
        // state) — they are NOT loaded as text into the model, so they have no
        // token cost worth reporting. README.md files are documentation, not config.
        if (ext === '.md' && !isNonContextFile(entry.name)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            if (isInvokeOnlyFile(fullPath)) {
              // Only the YAML frontmatter is injected on every message.
              const fm = extractFrontmatter(content);
              const fmEst = Math.ceil(fm.length / 4);
              const bodyEst = Math.ceil((content.length - fm.length) / 4);
              if (fmEst > 0) tokenEstimate = fmEst;
              if (bodyEst > 0) invokeTokenEstimate = bodyEst;
            } else {
              const est = Math.ceil(content.length / 4);
              if (est > 0) tokenEstimate = est;
            }
          } catch {
            // Ignore unreadable files — they still appear in the tree.
          }
        }
        nodes.push({
          path: fullPath,
          name: entry.name,
          isDirectory: false,
          tokenEstimate,
          invokeTokenEstimate,
        });
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
