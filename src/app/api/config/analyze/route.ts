import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { BadRequestError } from '@/lib/errors';
import { getConfigTree } from '@/lib/services/config-service';
import {
  SYSTEM_OVERHEAD,
  TOKEN_RELEVANT_ENV_VARS,
  computeMcpEstimate,
  computeCategories,
  computeSuggestions,
  type AnalysisResult,
  type SessionBaseline,
} from '@/lib/utils/token-analysis';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  const home = process.env.HOME ?? '/root';
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/**
 * Converts an absolute project path to the Claude Code project directory name.
 * e.g. /home/ubuntu/projects/agendo → -home-ubuntu-projects-agendo
 */
function projectPathToDirName(projectPath: string): string {
  return '-' + projectPath.replace(/\//g, '-').replace(/^-+/, '');
}

/**
 * Reads JSONL session files for a given project path (or all projects if null).
 * Returns up to 30 baselines sorted newest first.
 */
function readSessionBaselines(projectPath: string | null): SessionBaseline[] {
  const projectsBase = expandHome('~/.claude/projects');
  if (!fs.existsSync(projectsBase)) return [];

  let jsonlFiles: string[] = [];

  if (projectPath) {
    const dirName = projectPathToDirName(projectPath);
    const projectDir = path.join(projectsBase, dirName);
    if (fs.existsSync(projectDir)) {
      try {
        jsonlFiles = fs
          .readdirSync(projectDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(projectDir, f));
      } catch {
        return [];
      }
    }
  } else {
    // Global scope: scan all project subdirectories
    try {
      const dirs = fs.readdirSync(projectsBase, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const subDir = path.join(projectsBase, d.name);
        try {
          const files = fs
            .readdirSync(subDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => path.join(subDir, f));
          jsonlFiles.push(...files);
        } catch {
          // skip unreadable dirs
        }
      }
    } catch {
      return [];
    }
  }

  // Sort by mtime, newest first
  const withMtime = jsonlFiles.flatMap((f) => {
    try {
      const mtime = fs.statSync(f).mtimeMs;
      return [{ file: f, mtime }];
    } catch {
      return [];
    }
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);

  const baselines: SessionBaseline[] = [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  for (const { file, mtime } of withMtime) {
    if (mtime < thirtyDaysAgo) break;
    if (baselines.length >= 30) break;

    try {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line) as {
            message?: {
              usage?: {
                input_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
            };
          };
          if (data.message?.usage) {
            const u = data.message.usage;
            const total =
              (u.input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0);
            if (total > 0) {
              baselines.push({
                date: new Date(mtime).toISOString(),
                baselineTokens: total,
              });
              break; // only the first usage line per session file
            }
          }
        } catch {
          // malformed JSON line — skip
        }
      }
    } catch {
      // unreadable file — skip
    }
  }

  return baselines;
}

// ─── Route handler ───────────────────────────────────────────────────────────

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = (await req.json()) as { scope?: string };
  const scope = body.scope ?? 'global';

  if (typeof scope !== 'string') {
    throw new BadRequestError('scope must be a string');
  }

  const isGlobal = scope === 'global';

  // 1. Fetch the file tree for the requested scope
  const tree = isGlobal
    ? await getConfigTree('global')
    : await getConfigTree({ projectPath: scope });

  // 2. Fetch global token total (for project scopes only)
  let globalTokens: number | null = null;
  if (!isGlobal) {
    const globalTree = await getConfigTree('global');
    globalTokens = globalTree.reduce((acc, n) => acc + (n.tokenEstimate ?? 0), 0);
  }

  // 3. Read settings.json
  const settingsPath = expandHome('~/.claude/settings.json');
  let pluginCount = 0;
  let hasPreCompactHook = false;
  let hasPostToolUseHook = false;
  let autocompactPct: string | null = null;
  const envVars: Record<string, string> = {};
  let hasClaudeIgnore = false;

  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw) as {
      enabledPlugins?: Record<string, boolean>;
      mcpServers?: Record<string, unknown>;
      hooks?: { PreCompact?: unknown; PostToolUse?: unknown };
      env?: Record<string, string>;
    };

    const plugins = Object.values(settings.enabledPlugins ?? {}).filter(Boolean).length;
    const mcp = Object.keys(settings.mcpServers ?? {}).length;
    pluginCount = plugins + mcp;

    const preCompact = settings.hooks?.PreCompact;
    hasPreCompactHook = Array.isArray(preCompact) ? preCompact.length > 0 : !!preCompact;

    const postToolUse = settings.hooks?.PostToolUse;
    hasPostToolUseHook = Array.isArray(postToolUse) ? postToolUse.length > 0 : !!postToolUse;

    autocompactPct = settings.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? null;

    // Extract token-relevant env vars
    for (const key of TOKEN_RELEVANT_ENV_VARS) {
      const val = settings.env?.[key];
      if (val !== undefined) envVars[key] = val;
    }
  } catch {
    // settings.json missing or malformed — use defaults
  }

  hasClaudeIgnore = fs.existsSync(expandHome('~/.claude/.claudeignore'));

  // 4. Parse JSONL session baselines
  const sessionBaselines = readSessionBaselines(isGlobal ? null : scope);

  // 5. Compute categories and suggestions
  const categories = computeCategories(tree);
  const totalTokens = tree.reduce((acc, n) => acc + (n.tokenEstimate ?? 0), 0);
  const alwaysTotal = SYSTEM_OVERHEAD + (!isGlobal ? (globalTokens ?? 0) : 0) + totalTokens;
  const mcpEstimate = computeMcpEstimate(pluginCount);

  const suggestions = computeSuggestions({
    categories,
    pluginCount,
    hasPreCompactHook,
    hasPostToolUseHook,
    autocompactPct,
  });

  const result: AnalysisResult = {
    alwaysTotal,
    mcpEstimate,
    categories,
    suggestions,
    settings: {
      pluginCount,
      hasPreCompactHook,
      hasPostToolUseHook,
      autocompactPct,
      envVars,
      hasClaudeIgnore,
    },
    sessionBaselines,
    globalTokens,
  };

  return NextResponse.json({ data: result });
});
