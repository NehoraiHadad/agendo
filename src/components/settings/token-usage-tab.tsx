'use client';

import { useState, useCallback } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle, Info, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// ─── Types (mirroring measure.py snapshot JSON) ───────────────────────────────

interface ClaudeMdComponent {
  path: string;
  exists: boolean;
  tokens: number;
  lines: number;
  note?: string;
}

interface SkillsComponent {
  count: number;
  tokens: number;
  names: string[];
}

interface CommandsComponent {
  count: number;
  tokens: number;
  names: string[];
}

interface McpToolsComponent {
  server_count: number;
  server_names: string[];
  tool_count_estimate: number;
  tokens: number;
  note: string;
}

interface RulesComponent {
  count: number;
  tokens: number;
  always_loaded: number;
}

interface HooksComponent {
  configured: boolean;
  names: string[];
}

interface SkillFrontmatterQuality {
  verbose_count: number;
  verbose_skills: { name: string; description_chars: number }[];
}

interface SnapshotComponents {
  [key: string]: unknown;
  skills?: SkillsComponent;
  commands?: CommandsComponent;
  mcp_tools?: McpToolsComponent;
  rules?: RulesComponent;
  hooks?: HooksComponent;
  skill_frontmatter_quality?: SkillFrontmatterQuality;
  memory_md?: { path: string; exists: boolean; tokens: number; lines: number };
}

interface Totals {
  controllable_tokens: number;
  fixed_tokens: number;
  estimated_total: number;
}

interface SessionBaseline {
  date: string;
  baseline_tokens: number;
}

interface Snapshot {
  label: string;
  timestamp: string;
  components: SnapshotComponents;
  totals: Totals;
  session_baselines: SessionBaseline[];
  context_window: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return `~${n}`;
  return `~${(n / 1000).toFixed(1)}K`;
}

function pctOfContext(tokens: number, contextWindow = 200_000): number {
  return Math.round((tokens / contextWindow) * 100 * 10) / 10;
}

function tokenColor(pct: number): string {
  if (pct > 15) return 'oklch(0.65 0.22 25)';
  if (pct > 5) return 'oklch(0.72 0.18 60)';
  return 'oklch(0.65 0.15 140)';
}

function isClaudeMdKey(key: string): boolean {
  return key.startsWith('claude_md_');
}

function buildRows(
  snapshot: Snapshot,
): { label: string; tokens: number; detail: string; color: string }[] {
  const rows: { label: string; tokens: number; detail: string; color: string }[] = [];
  const c = snapshot.components;

  // CLAUDE.md files
  for (const [key, val] of Object.entries(c)) {
    if (!isClaudeMdKey(key)) continue;
    const v = val as ClaudeMdComponent;
    if (!v.exists || v.tokens === 0) continue;
    const shortPath = v.path.replace(/^\/home\/[^/]+\//, '~/');
    rows.push({
      label: shortPath.endsWith('CLAUDE.md') ? shortPath : 'CLAUDE.md',
      tokens: v.tokens,
      detail: `${v.lines} lines`,
      color: 'oklch(0.62 0.13 225)',
    });
  }

  // MEMORY.md
  if (c.memory_md?.exists && (c.memory_md.tokens ?? 0) > 0) {
    rows.push({
      label: 'MEMORY.md',
      tokens: c.memory_md.tokens,
      detail: `${c.memory_md.lines} lines${c.memory_md.lines > 200 ? ' ⚠ >200-line cap' : ''}`,
      color: 'oklch(0.64 0.13 280)',
    });
  }

  // Skills
  if (c.skills && c.skills.count > 0) {
    rows.push({
      label: 'Skills (frontmatter)',
      tokens: c.skills.tokens,
      detail: `${c.skills.count} skills`,
      color: 'oklch(0.68 0.16 55)',
    });
  }

  // Commands
  if (c.commands && c.commands.count > 0) {
    rows.push({
      label: 'Commands (frontmatter)',
      tokens: c.commands.tokens,
      detail: `${c.commands.count} commands`,
      color: 'oklch(0.65 0.14 150)',
    });
  }

  // MCP
  if (c.mcp_tools && c.mcp_tools.server_count > 0) {
    rows.push({
      label: 'MCP tools',
      tokens: c.mcp_tools.tokens,
      detail: `${c.mcp_tools.server_count} servers, ~${c.mcp_tools.tool_count_estimate} tools`,
      color: 'oklch(0.65 0.18 320)',
    });
  }

  // Rules
  if (c.rules && c.rules.count > 0) {
    rows.push({
      label: '.claude/rules/',
      tokens: c.rules.tokens,
      detail: `${c.rules.count} files`,
      color: 'oklch(0.62 0.12 200)',
    });
  }

  // Fixed system overhead
  const fixedTokens = snapshot.totals.fixed_tokens;
  if (fixedTokens > 0) {
    rows.push({
      label: 'System overhead (fixed)',
      tokens: fixedTokens,
      detail: 'built-in tools + system prompt',
      color: 'oklch(0.45 0.04 260)',
    });
  }

  // Sort by tokens descending, keep fixed at bottom
  const fixed = rows.filter((r) => r.label === 'System overhead (fixed)');
  const variable = rows
    .filter((r) => r.label !== 'System overhead (fixed)')
    .sort((a, b) => b.tokens - a.tokens);

  return [...variable, ...fixed];
}

function buildSuggestions(
  snapshot: Snapshot,
): { level: 'warn' | 'info' | 'good'; title: string; detail: string }[] {
  const suggestions: { level: 'warn' | 'info' | 'good'; title: string; detail: string }[] = [];
  const c = snapshot.components;
  let hasWarn = false;

  // CLAUDE.md size (from measure.py: target <800 tokens)
  let claudeMdTotal = 0;
  for (const [key, val] of Object.entries(c)) {
    if (isClaudeMdKey(key)) {
      const v = val as ClaudeMdComponent;
      if (v.exists) claudeMdTotal += v.tokens;
    }
  }
  if (claudeMdTotal > 800) {
    hasWarn = true;
    suggestions.push({
      level: 'warn',
      title: `CLAUDE.md is ${fmtTokens(claudeMdTotal)} — target <800`,
      detail: 'Move infrequent rules to skills. Put stable sections first for prompt cache hits.',
    });
  }

  // MEMORY.md size
  if (c.memory_md?.exists && c.memory_md.tokens > 600) {
    hasWarn = true;
    suggestions.push({
      level: 'warn',
      title: `MEMORY.md is ${fmtTokens(c.memory_md.tokens)} — target <600`,
      detail:
        'Remove duplicates of CLAUDE.md. Keep learnings and corrections only. Content past line 200 is auto-truncated.',
    });
  }

  // Skills verbose descriptions
  const q = c.skill_frontmatter_quality;
  if (q && q.verbose_count > 0) {
    suggestions.push({
      level: 'info',
      title: `${q.verbose_count} skill(s) have verbose descriptions (>200 chars)`,
      detail: `Skills: ${q.verbose_skills
        .slice(0, 5)
        .map((s) => s.name)
        .join(
          ', ',
        )}${q.verbose_count > 5 ? '...' : ''}. Shorter descriptions save tokens every session.`,
    });
  }

  // Hooks not configured
  if (c.hooks && !c.hooks.configured) {
    suggestions.push({
      level: 'info',
      title: 'No hooks configured',
      detail:
        'A PreCompact hook captures key decisions before /compact. A PostToolUse hook prevents verbose explanations after file writes.',
    });
  }

  // MEMORY.md over 200 lines
  if (c.memory_md?.exists && c.memory_md.lines > 200) {
    suggestions.push({
      level: 'warn',
      title: `MEMORY.md is ${c.memory_md.lines} lines — auto-truncated at 200`,
      detail: 'Claude Code only loads the first 200 lines. Move detailed content to topic files.',
    });
    hasWarn = true;
  }

  if (!hasWarn) {
    suggestions.push({
      level: 'good',
      title: 'Config looks lean',
      detail:
        'Run /compact at 50–70% fill (not the default 95%). Use /clear between unrelated topics.',
    });
  }

  return suggestions;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BarRow({
  label,
  tokens,
  detail,
  color,
  total,
}: {
  label: string;
  tokens: number;
  detail: string;
  color: string;
  total: number;
}) {
  const pct = total > 0 ? (tokens / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="w-36 shrink-0 text-[12px] text-foreground/70 truncate" title={label}>
        {label}
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${Math.min(pct, 100)}%`, background: color }}
          />
        </div>
        <span className="text-[11px] font-mono text-foreground/60 w-12 text-right shrink-0">
          {fmtTokens(tokens)}
        </span>
      </div>
      <div className="w-28 shrink-0 text-[11px] text-muted-foreground/40 text-right truncate">
        {detail}
      </div>
    </div>
  );
}

function SuggestionRow({
  level,
  title,
  detail,
}: {
  level: 'warn' | 'info' | 'good';
  title: string;
  detail: string;
}) {
  const icon =
    level === 'warn' ? (
      <AlertTriangle
        className="h-3.5 w-3.5 shrink-0 mt-0.5"
        style={{ color: 'oklch(0.72 0.18 60)' }}
      />
    ) : level === 'good' ? (
      <CheckCircle
        className="h-3.5 w-3.5 shrink-0 mt-0.5"
        style={{ color: 'oklch(0.65 0.15 140)' }}
      />
    ) : (
      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" style={{ color: 'oklch(0.62 0.13 225)' }} />
    );

  return (
    <div className="flex gap-2.5 py-2.5 border-b border-white/[0.04] last:border-0">
      {icon}
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-foreground/80">{title}</div>
        <div className="text-[11px] text-muted-foreground/50 mt-0.5 leading-relaxed">{detail}</div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function TokenUsageTab() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notInstalled, setNotInstalled] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/token-usage');
      if (res.status === 404) {
        setNotInstalled(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        setError(body.message ?? 'Failed to run measure.py');
        return;
      }
      const body = (await res.json()) as { data: Snapshot };
      setSnapshot(body.data);
      setNotInstalled(false);
    } catch {
      setError('Network error — could not reach /api/token-usage');
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Not yet run ──
  if (!snapshot && !loading && !error && !notInstalled) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 gap-4 text-center">
        <div
          className="h-12 w-12 rounded-xl flex items-center justify-center"
          style={{
            background:
              'linear-gradient(135deg, oklch(0.7 0.18 55 / 0.15) 0%, oklch(0.6 0.16 45 / 0.08) 100%)',
            border: '1px solid oklch(0.7 0.18 55 / 0.12)',
          }}
        >
          <Zap className="h-5 w-5" style={{ color: 'oklch(0.7 0.18 55)' }} />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground/80">Token Usage Audit</p>
          <p className="text-[12px] text-muted-foreground/50 mt-1 max-w-xs">
            Measure your per-session token overhead across CLAUDE.md, MEMORY.md, skills, commands,
            and MCP servers.
          </p>
        </div>
        <Button size="sm" onClick={refresh} className="mt-2">
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Run Analysis
        </Button>
      </div>
    );
  }

  // ── Not installed ──
  if (notInstalled) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 gap-3 text-center">
        <AlertTriangle className="h-8 w-8" style={{ color: 'oklch(0.72 0.18 60)' }} />
        <div>
          <p className="text-sm font-medium text-foreground/80">token-optimizer not installed</p>
          <p className="text-[12px] text-muted-foreground/50 mt-1">
            Run in Claude Code:{' '}
            <code className="font-mono text-foreground/60">
              /plugin marketplace add alexgreensh/token-optimizer
            </code>
          </p>
        </div>
      </div>
    );
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 gap-3">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground/40" />
        <p className="text-[12px] text-muted-foreground/50">Running measure.py…</p>
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-20 gap-3 text-center">
        <AlertTriangle className="h-6 w-6" style={{ color: 'oklch(0.65 0.22 25)' }} />
        <div>
          <p className="text-sm font-medium text-foreground/80">Analysis failed</p>
          <p className="text-[12px] text-muted-foreground/50 mt-1 max-w-sm">{error}</p>
        </div>
        <Button size="sm" variant="outline" onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  }

  if (!snapshot) return null;

  const ctx = snapshot.context_window ?? 200_000;
  const total = snapshot.totals.estimated_total;
  const pct = pctOfContext(total, ctx);
  const ctxLabel = `${ctx / 1000}K`;
  const rows = buildRows(snapshot);
  const suggestions = buildSuggestions(snapshot);
  const baselines = snapshot.session_baselines ?? [];
  const avgBaseline =
    baselines.length > 0
      ? Math.round(baselines.reduce((s, b) => s + b.baseline_tokens, 0) / baselines.length)
      : null;

  return (
    <div className="flex flex-col gap-4 h-full min-h-0 overflow-y-auto pb-6">
      {/* Header row */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <p className="text-[11px] text-muted-foreground/40">
            Snapshot: {new Date(snapshot.timestamp).toLocaleString()}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={refresh}
          disabled={loading}
          className="h-7 text-[12px]"
        >
          <RefreshCw className={cn('h-3 w-3 mr-1.5', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 shrink-0">
        <div
          className="rounded-lg border border-white/[0.06] p-3"
          style={{ background: 'oklch(0.09 0 0)' }}
        >
          <div className="text-[11px] text-muted-foreground/40 mb-1">Estimated total</div>
          <div
            className="text-2xl font-bold font-mono leading-none"
            style={{ color: tokenColor(pct) }}
          >
            {fmtTokens(total)}
          </div>
          <div className="text-[11px] text-muted-foreground/40 mt-1">
            {pct}% of {ctxLabel} window
          </div>
        </div>

        <div
          className="rounded-lg border border-white/[0.06] p-3"
          style={{ background: 'oklch(0.09 0 0)' }}
        >
          <div className="text-[11px] text-muted-foreground/40 mb-1">Controllable</div>
          <div className="text-2xl font-bold font-mono leading-none text-foreground/80">
            {fmtTokens(snapshot.totals.controllable_tokens)}
          </div>
          <div className="text-[11px] text-muted-foreground/40 mt-1">
            {pctOfContext(snapshot.totals.controllable_tokens, ctx)}% reducible
          </div>
        </div>

        {avgBaseline !== null && (
          <div
            className="rounded-lg border border-white/[0.06] p-3 col-span-2 sm:col-span-1"
            style={{ background: 'oklch(0.09 0 0)' }}
          >
            <div className="text-[11px] text-muted-foreground/40 mb-1">
              Real baseline (avg {baselines.length})
            </div>
            <div className="text-2xl font-bold font-mono leading-none text-foreground/80">
              {fmtTokens(avgBaseline)}
            </div>
            <div className="text-[11px] text-muted-foreground/40 mt-1">from JSONL session logs</div>
          </div>
        )}
      </div>

      {/* Breakdown */}
      <div
        className="rounded-lg border border-white/[0.06] overflow-hidden shrink-0"
        style={{ background: 'oklch(0.09 0 0)' }}
      >
        <div className="px-4 py-2.5 border-b border-white/[0.04]">
          <h3 className="text-[12px] font-semibold text-foreground/70">Breakdown</h3>
        </div>
        <div className="px-4 divide-y divide-white/[0.03]">
          {rows.map((row) => (
            <BarRow key={row.label} {...row} total={total} />
          ))}
        </div>
      </div>

      {/* Session baselines */}
      {baselines.length > 0 && (
        <div
          className="rounded-lg border border-white/[0.06] overflow-hidden shrink-0"
          style={{ background: 'oklch(0.09 0 0)' }}
        >
          <div className="px-4 py-2.5 border-b border-white/[0.04]">
            <h3 className="text-[12px] font-semibold text-foreground/70">
              Recent Session Baselines
            </h3>
          </div>
          <div className="px-4 py-2 divide-y divide-white/[0.03]">
            {baselines.slice(0, 8).map((b, i) => (
              <div key={i} className="flex items-center justify-between py-1.5">
                <span className="text-[11px] text-muted-foreground/50">
                  {new Date(b.date).toLocaleString()}
                </span>
                <span className="text-[12px] font-mono text-foreground/70">
                  {fmtTokens(b.baseline_tokens)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Suggestions */}
      <div
        className="rounded-lg border border-white/[0.06] overflow-hidden shrink-0"
        style={{ background: 'oklch(0.09 0 0)' }}
      >
        <div className="px-4 py-2.5 border-b border-white/[0.04]">
          <h3 className="text-[12px] font-semibold text-foreground/70">Recommendations</h3>
        </div>
        <div className="px-4">
          {suggestions.map((s, i) => (
            <SuggestionRow key={i} {...s} />
          ))}
        </div>
      </div>
    </div>
  );
}
