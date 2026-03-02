/**
 * Shared token analysis logic for the Config editor token budget panel and
 * the /config/analyze dashboard.
 *
 * Methodology based on token-optimizer by @alexgreensh
 * https://github.com/alexgreensh/token-optimizer
 * Licensed under Apache-2.0 (see NOTICE in source repo)
 */

import { type TreeNode } from '@/lib/services/config-service';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SYSTEM_OVERHEAD = 15_000;
export const CONTEXT_WINDOW = 200_000;
export const CHARS_PER_TOKEN = 4;

/** Tokens per MCP tool name when Tool Search is active (deferred definitions). */
export const MCP_TOKENS_PER_TOOL = 15;
/** Estimated average number of tools per MCP server / plugin. */
export const MCP_TOOLS_PER_PLUGIN_EST = 8;
/** Per-server instruction overhead (~50–100 tokens each). */
export const MCP_SERVER_INSTRUCTIONS_EST = 75;
/**
 * Fixed overhead for the Tool Search menu itself (active when ≥1 MCP server).
 * Source: token flow reference — "MCP (Tool Search + names): ~500 + ~15 per deferred tool"
 */
export const MCP_TOOLSEARCH_BASE = 500;

/**
 * Environment variables in settings.json that directly affect token budget or
 * context behaviour.  These are the vars from checklist items 23–30.
 */
export const TOKEN_RELEVANT_ENV_VARS = [
  'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', // #30 — auto-compact threshold (recommend 70)
  'ENABLE_TOOL_SEARCH', // #27 — defers MCP defs; 85% MCP savings
  'CLAUDE_CODE_MAX_THINKING_TOKENS', // #23 — extended thinking budget (default 10K)
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS', // #24 — max output per response (default 16K)
  'MAX_MCP_OUTPUT_TOKENS', // #25 — per-tool output limit (default 25K)
  'BASH_MAX_OUTPUT_LENGTH', // #26 — bash stdout capture limit
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY', // #28 — disables auto-memory writes
  'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', // #29 — disables adaptive thinking depth
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BudgetFile {
  name: string;
  path: string;
  tokens: number;
  invokeTokens: number;
}

export interface CategoryData {
  key: string;
  label: string;
  color: string;
  description: string;
  tokens: number;
  invokeTokens: number;
  files: BudgetFile[];
}

export interface Suggestion {
  level: 'warn' | 'info' | 'good';
  title: string;
  detail: string;
  savings?: number;
  /** If set, the Quick Wins "Fix" button triggers this action. */
  action?:
    | 'add-precompact-hook'
    | 'add-posttooluse-hook'
    | 'set-autocompact'
    | 'create-claudeignore';
  actionValue?: string;
}

export interface SessionBaseline {
  date: string;
  baselineTokens: number;
}

export interface TokenAction {
  action:
    | 'add-precompact-hook'
    | 'add-posttooluse-hook'
    | 'set-autocompact'
    | 'create-claudeignore';
  value?: string;
}

export interface AnalysisResult {
  alwaysTotal: number;
  mcpEstimate: number;
  categories: CategoryData[];
  suggestions: Suggestion[];
  settings: {
    pluginCount: number;
    hasPreCompactHook: boolean;
    hasPostToolUseHook: boolean;
    autocompactPct: string | null;
    envVars: Record<string, string>;
    hasClaudeIgnore: boolean;
  };
  sessionBaselines: SessionBaseline[];
  /** null when scope is already global */
  globalTokens: number | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function fmtTokens(n: number): string {
  if (n < 1000) return `~${n}`;
  return `~${(n / 1000).toFixed(1)}K`;
}

export function alpha(color: string, a: number): string {
  return color.replace(')', ` / ${a})`);
}

/**
 * Computes the total MCP / plugin token estimate including:
 * - Tool Search base overhead (~500 tokens when any server is active)
 * - Deferred tool names (~15 tokens each, avg 8 tools/server)
 * - Server instructions (~75 tokens per server)
 *
 * Returns 0 when pluginCount is 0 (no Tool Search menu loaded).
 */
export function computeMcpEstimate(pluginCount: number): number {
  if (pluginCount <= 0) return 0;
  return (
    MCP_TOOLSEARCH_BASE +
    pluginCount * (MCP_TOOLS_PER_PLUGIN_EST * MCP_TOKENS_PER_TOOL + MCP_SERVER_INSTRUCTIONS_EST)
  );
}

// ─── Tree walking ─────────────────────────────────────────────────────────────

function flattenFiles(node: TreeNode): BudgetFile[] {
  if (!node.isDirectory) {
    const tokens = node.tokenEstimate ?? 0;
    const invokeTokens = node.invokeTokenEstimate ?? 0;
    if (tokens > 0 || invokeTokens > 0) {
      return [{ name: node.name, path: node.path, tokens, invokeTokens }];
    }
    return [];
  }
  return (node.children ?? []).flatMap(flattenFiles);
}

export function computeCategories(tree: TreeNode[]): CategoryData[] {
  const cfg: CategoryData = {
    key: 'config',
    label: 'Config Files',
    color: 'oklch(0.62 0.13 225)',
    description: 'CLAUDE.md, MEMORY.md and root markdown files',
    tokens: 0,
    invokeTokens: 0,
    files: [],
  };
  const agts: CategoryData = {
    key: 'agents',
    label: 'Agents',
    color: 'oklch(0.64 0.13 200)',
    description: 'Agent persona definitions (agents/*.md)',
    tokens: 0,
    invokeTokens: 0,
    files: [],
  };
  const skls: CategoryData = {
    key: 'skills',
    label: 'Skills',
    color: 'oklch(0.68 0.16 55)',
    description: 'Frontmatter always loaded · body loaded on invoke',
    tokens: 0,
    invokeTokens: 0,
    files: [],
  };
  const cmds: CategoryData = {
    key: 'commands',
    label: 'Commands',
    color: 'oklch(0.65 0.14 150)',
    description: 'Frontmatter always loaded · body loaded on invoke',
    tokens: 0,
    invokeTokens: 0,
    files: [],
  };

  for (const node of tree) {
    switch (node.name) {
      case 'skills':
        skls.tokens = node.tokenEstimate ?? 0;
        skls.files = flattenFiles(node);
        skls.invokeTokens = skls.files.reduce((s, f) => s + f.invokeTokens, 0);
        break;
      case 'commands':
        cmds.tokens = node.tokenEstimate ?? 0;
        cmds.files = flattenFiles(node);
        cmds.invokeTokens = cmds.files.reduce((s, f) => s + f.invokeTokens, 0);
        break;
      case 'agents':
        agts.tokens = node.tokenEstimate ?? 0;
        agts.files = flattenFiles(node);
        break;
      default:
        if (!node.isDirectory && (node.tokenEstimate ?? 0) > 0) {
          cfg.tokens += node.tokenEstimate ?? 0;
          cfg.files.push({
            name: node.name,
            path: node.path,
            tokens: node.tokenEstimate ?? 0,
            invokeTokens: 0,
          });
        }
    }
  }

  return [cfg, agts, skls, cmds].filter((c) => c.tokens > 0 || c.files.length > 0);
}

export function computeSuggestions({
  categories,
  pluginCount,
  hasPreCompactHook,
  hasPostToolUseHook,
  autocompactPct,
}: {
  categories: CategoryData[];
  pluginCount: number | null;
  hasPreCompactHook: boolean | null;
  hasPostToolUseHook: boolean | null;
  autocompactPct: string | null;
}): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // CLAUDE.md size (target: <800 tokens per token-optimizer playbook)
  const configCat = categories.find((c) => c.key === 'config');
  const claudeMd = configCat?.files.find(
    (f) => f.name === 'CLAUDE.md' || f.name === 'CLAUDE.local.md',
  );
  if (claudeMd && claudeMd.tokens > 800) {
    suggestions.push({
      level: 'warn',
      title: `CLAUDE.md is ${fmtTokens(claudeMd.tokens)} — target <800`,
      detail:
        'Move infrequent rules to a skill file. Place stable sections first to maximise prompt cache hits (96-97% hit rate).',
      savings: claudeMd.tokens - 800,
    });
  }

  // MEMORY.md size (target: <600 tokens per token-optimizer playbook)
  const memoryMd = configCat?.files.find((f) => f.name === 'MEMORY.md');
  if (memoryMd && memoryMd.tokens > 600) {
    suggestions.push({
      level: 'warn',
      title: `MEMORY.md is ${fmtTokens(memoryMd.tokens)} — target <600`,
      detail:
        'Remove content that duplicates CLAUDE.md (choose one source of truth). Keep only: learnings, corrections, habit tracking. Condense verbose operational history to current rule only.',
      savings: memoryMd.tokens - 600,
    });
  }

  // Skills frontmatter quality (target: ~100 tokens/skill)
  const skillsCat = categories.find((c) => c.key === 'skills');
  if (skillsCat && skillsCat.files.length > 0) {
    const avg = Math.round(skillsCat.tokens / skillsCat.files.length);
    if (avg > 120) {
      suggestions.push({
        level: 'info',
        title: `Skills avg ${avg} tokens/skill — target ~100`,
        detail:
          'Frontmatter descriptions may be verbose. Tightening saves tokens every session without losing invoke functionality.',
        savings: Math.round((avg - 100) * skillsCat.files.length),
      });
    }
  }

  // PreCompact hook missing
  if (hasPreCompactHook === false) {
    suggestions.push({
      level: 'info',
      title: 'No PreCompact hook — /compact loses key decisions',
      detail:
        'A hook guides the synthesis agent to preserve code changes and decisions while discarding verbose output.',
      action: 'add-precompact-hook',
    });
  }

  // PostToolUse hook missing (suppresses formatting explanations — saves output tokens)
  if (hasPostToolUseHook === false) {
    suggestions.push({
      level: 'info',
      title: 'No PostToolUse hook — Claude explains formatting after every file write',
      detail:
        'A hook tells Claude the formatter handled it, preventing verbose style explanations after Write/Edit tool calls. Saves output tokens on every file modification.',
      action: 'add-posttooluse-hook',
    });
  }

  // CLAUDE_AUTOCOMPACT_PCT_OVERRIDE not set (or too high)
  const pctNum = autocompactPct != null ? parseInt(autocompactPct, 10) : null;
  if (autocompactPct == null) {
    suggestions.push({
      level: 'info',
      title: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE not set (auto-compact near 95%)',
      detail:
        'Quality degrades at 50–70% fill — auto-compact triggers after the damage. Set to 70 in settings.json env.',
      action: 'set-autocompact',
      actionValue: '70',
    });
  } else if (pctNum != null && pctNum > 80) {
    suggestions.push({
      level: 'info',
      title: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${autocompactPct} — recommend 70`,
      detail:
        'Still too high. Quality degrades before this threshold; earlier compaction keeps responses sharp.',
      action: 'set-autocompact',
      actionValue: '70',
    });
  }

  // MCP / plugin count info
  if (pluginCount != null && pluginCount > 0) {
    const est = computeMcpEstimate(pluginCount);
    suggestions.push({
      level: 'info',
      title: `${pluginCount} MCP servers → est. ${fmtTokens(est)} overhead`,
      detail: `Tool Search defers definitions (~${MCP_TOKENS_PER_TOOL} tokens/tool name + ~${MCP_SERVER_INSTRUCTIONS_EST} per server instructions + ~${MCP_TOOLSEARCH_BASE} base). Disable unused servers to reduce.`,
    });
  }

  if (suggestions.filter((s) => s.level === 'warn').length === 0) {
    suggestions.push({
      level: 'good',
      title: 'Config looks lean — focus shifts to behavioural habits',
      detail:
        'Run /compact at 50–70% fill (not the default 95%). Use /clear between unrelated topics. Check /context periodically.',
    });
  }

  // Behavioural tip: always relevant (highest cumulative impact per the checklist)
  suggestions.push({
    level: 'info',
    title: 'Default subagents to haiku — 50–60% savings on multi-agent workflows',
    detail:
      'Add one line to CLAUDE.md: "haiku for file reading/counting/scanning, sonnet for analysis, opus for novel reasoning." This compounds across every subagent call every session.',
  });

  return suggestions;
}
