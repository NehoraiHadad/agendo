'use client';

import { useState, useCallback, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BarChart2,
  Loader2,
  AlertCircle,
  Zap,
  TrendingUp,
  Settings2,
  ArrowLeft,
  CheckCircle2,
  Sparkles,
  RefreshCw,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfigScopeSelector } from '@/components/config/config-scope-selector';
import { BarSegment, CategoryRow, SuggestionCard } from '@/components/config/token-analysis-ui';
import {
  SYSTEM_OVERHEAD,
  CONTEXT_WINDOW,
  MCP_TOKENS_PER_TOOL,
  MCP_TOOLS_PER_PLUGIN_EST,
  MCP_SERVER_INSTRUCTIONS_EST,
  TOKEN_RELEVANT_ENV_VARS,
  alpha,
  fmtTokens,
  type AnalysisResult,
  type Suggestion,
} from '@/lib/utils/token-analysis';
import { cn } from '@/lib/utils';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProjectOption {
  id: string;
  name: string;
  rootPath: string;
}

interface Props {
  projects: ProjectOption[];
}

type DashboardState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; result: AnalysisResult }
  | { phase: 'error'; message: string };

// ─── Sparkline ───────────────────────────────────────────────────────────────

function Sparkline({ data }: { data: { baselineTokens: number }[] }) {
  if (data.length < 2) return null;

  const W = 240;
  const H = 48;
  const pad = 4;
  const values = data.map((d) => d.baselineTokens);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (W - pad * 2);
    const y = pad + ((max - v) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const polyline = pts.join(' ');

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="overflow-visible"
      aria-hidden="true"
    >
      <polyline
        points={polyline}
        fill="none"
        stroke="oklch(0.62 0.13 225 / 0.5)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {values.map((v, i) => {
        const [x, y] = pts[i].split(',').map(Number);
        return (
          <circle key={i} cx={x} cy={y} r="2" fill="oklch(0.62 0.13 225)">
            <title>{fmtTokens(v)}</title>
          </circle>
        );
      })}
    </svg>
  );
}

// ─── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({ result }: { result: AnalysisResult }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { alwaysTotal, mcpEstimate, categories, settings, globalTokens } = result;
  const isProjectScope = globalTokens !== null;

  const contextPct = alwaysTotal / CONTEXT_WINDOW;
  const totalColor =
    contextPct > 0.15
      ? 'oklch(0.65 0.22 25)'
      : contextPct > 0.05
        ? 'oklch(0.72 0.18 60)'
        : 'oklch(0.65 0.15 140)';

  const systemColor = 'oklch(0.60 0.17 285)';
  const globalColor = 'oklch(0.58 0.10 240)';
  const mcpColor = 'oklch(0.55 0.08 300)';

  const barTotal = alwaysTotal + mcpEstimate || 1;

  const barSlices = [
    { key: 'system', label: 'System', color: systemColor, tokens: SYSTEM_OVERHEAD, dashed: false },
    ...(isProjectScope && (globalTokens ?? 0) > 0
      ? [
          {
            key: 'global',
            label: 'Global Config',
            color: globalColor,
            tokens: globalTokens ?? 0,
            dashed: false,
          },
        ]
      : []),
    ...categories.map((c) => ({
      key: c.key,
      label: c.label,
      color: c.color,
      tokens: c.tokens,
      dashed: false,
    })),
    ...(mcpEstimate > 0
      ? [
          {
            key: 'mcp',
            label: 'MCP / Plugins (est.)',
            color: mcpColor,
            tokens: mcpEstimate,
            dashed: true,
          },
        ]
      : []),
  ];

  const invokeTotal = categories.reduce((s, c) => s + c.invokeTokens, 0);

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Big number */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/25 mb-1.5">
            Always-loaded tokens
          </p>
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span
              className="text-4xl font-mono font-bold tracking-tight tabular-nums"
              style={{ color: totalColor, textShadow: `0 0 24px ${alpha(totalColor, 0.35)}` }}
            >
              {fmtTokens(alwaysTotal)}
            </span>
            <span className="text-xs font-mono text-muted-foreground/30 whitespace-nowrap">
              / 200K &nbsp;·&nbsp; {(contextPct * 100).toFixed(1)}% used
            </span>
          </div>
          {mcpEstimate > 0 && (
            <p className="text-[10px] font-mono text-muted-foreground/20 mt-0.5">
              +{fmtTokens(mcpEstimate)} MCP est. → full est. {fmtTokens(alwaysTotal + mcpEstimate)}
            </p>
          )}
        </div>
        {invokeTotal > 0 && (
          <div className="text-right shrink-0">
            <p className="text-[9px] text-muted-foreground/20 uppercase tracking-widest leading-none">
              on invoke
            </p>
            <p className="text-sm font-mono text-muted-foreground/30 mt-1">
              +{fmtTokens(invokeTotal)}↗
            </p>
          </div>
        )}
      </div>

      {/* Stacked bar */}
      <div>
        <div
          className="flex h-3 rounded-full overflow-hidden"
          style={{ background: 'oklch(0.11 0 0)', gap: '1.5px' }}
        >
          {barSlices.map((s, i) => (
            <BarSegment
              key={s.key}
              color={s.color}
              width={Math.max((s.tokens / barTotal) * 100, 0.4)}
              delay={i * 80}
              label={s.label}
              tokens={s.tokens}
              dashed={s.dashed}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-2.5">
          {barSlices.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <div
                className="h-1.5 w-1.5 rounded-sm shrink-0"
                style={{ background: s.color, opacity: s.dashed ? 0.5 : 1 }}
              />
              <span className="text-[9px] text-muted-foreground/35 tracking-wide">
                {s.label}
                {s.dashed ? ' ···' : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="h-px" style={{ background: 'oklch(0.14 0 0)' }} />

      {/* Category rows */}
      <div className="flex flex-col gap-2">
        <CategoryRow
          label="System"
          description="Claude system prompt + 18 built-in tools · fixed overhead"
          color={systemColor}
          tokens={SYSTEM_OVERHEAD}
          invokeTokens={0}
          files={[]}
          isExpanded={false}
          onToggle={null}
        />
        {isProjectScope && (globalTokens ?? 0) > 0 && (
          <CategoryRow
            label="Global Config"
            description="Switch to Global scope to see the full breakdown"
            color={globalColor}
            tokens={globalTokens ?? 0}
            invokeTokens={0}
            files={[]}
            isExpanded={false}
            onToggle={null}
          />
        )}
        {categories.map((cat) => (
          <CategoryRow
            key={cat.key}
            label={cat.label}
            description={cat.description}
            color={cat.color}
            tokens={cat.tokens}
            invokeTokens={cat.invokeTokens}
            files={cat.files}
            badge={cat.files.length > 0 ? String(cat.files.length) : undefined}
            isExpanded={expanded[cat.key] ?? false}
            onToggle={cat.files.length > 0 ? () => toggle(cat.key) : null}
          />
        ))}

        {/* MCP row */}
        {settings.pluginCount > 0 && (
          <div
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
            style={{
              background: 'oklch(0.09 0 0)',
              borderLeft: `2px solid ${alpha(mcpColor, 0.5)}`,
            }}
          >
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-muted-foreground/45">MCP & Plugins</p>
              <p className="text-[10px] text-muted-foreground/20 mt-0.5">
                ~500 base + {settings.pluginCount} × (~{MCP_TOOLS_PER_PLUGIN_EST} tools ×{' '}
                {MCP_TOKENS_PER_TOOL} + ~{MCP_SERVER_INSTRUCTIONS_EST} instructions)
              </p>
            </div>
            <span
              className="text-sm font-mono font-semibold shrink-0"
              style={{ color: alpha(mcpColor, 0.7) }}
            >
              {fmtTokens(mcpEstimate)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Quick Wins tab ───────────────────────────────────────────────────────────

function QuickWinsTab({
  suggestions,
  onFix,
  fixingAction,
}: {
  suggestions: Suggestion[];
  onFix: (action: NonNullable<Suggestion['action']>, value?: string) => void;
  fixingAction: string | null;
}) {
  const fixable = suggestions.filter((s) => s.action);
  const nonFixable = suggestions.filter((s) => !s.action);
  const warnCount = suggestions.filter((s) => s.level === 'warn').length;

  return (
    <div className="flex flex-col gap-4">
      {/* Summary */}
      <div className="flex items-center gap-3">
        {warnCount > 0 ? (
          <span
            className="text-[10px] px-2 py-1 rounded-full font-mono"
            style={{
              background: 'oklch(0.72 0.18 60 / 0.15)',
              color: 'oklch(0.72 0.18 60 / 0.8)',
            }}
          >
            {warnCount} actionable
          </span>
        ) : (
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3 w-3" style={{ color: 'oklch(0.65 0.15 140)' }} />
            <span className="text-[11px] text-muted-foreground/40">Looking good</span>
          </div>
        )}
        {fixable.length > 0 && (
          <span className="text-[10px] text-muted-foreground/30">
            {fixable.length} one-click fix{fixable.length > 1 ? 'es' : ''} available
          </span>
        )}
      </div>

      {/* Fixable suggestions */}
      {fixable.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/25 mb-1">
            One-click fixes
          </p>
          {fixable.map((s, i) => (
            <SuggestionCard key={i} s={s} onFix={onFix} isFixing={fixingAction === s.action} />
          ))}
        </div>
      )}

      {/* Info / good suggestions */}
      {nonFixable.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/25 mb-1">
            Tips
          </p>
          {nonFixable.map((s, i) => (
            <SuggestionCard key={i} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Trends tab ───────────────────────────────────────────────────────────────

function TrendsTab({ baselines }: { baselines: AnalysisResult['sessionBaselines'] }) {
  if (baselines.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <TrendingUp className="h-6 w-6 text-muted-foreground/15" />
        <p className="text-sm text-muted-foreground/30">No session data found</p>
        <p className="text-[11px] text-muted-foreground/20 max-w-xs leading-relaxed">
          Session JSONL logs are stored in ~/.claude/projects/. Start a Claude session in a tracked
          project to see baseline data here.
        </p>
      </div>
    );
  }

  const avg = Math.round(baselines.reduce((s, b) => s + b.baselineTokens, 0) / baselines.length);
  const maxVal = Math.max(...baselines.map((b) => b.baselineTokens));
  const minVal = Math.min(...baselines.map((b) => b.baselineTokens));

  return (
    <div className="flex flex-col gap-5">
      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Sessions', value: String(baselines.length) },
          { label: 'Avg baseline', value: fmtTokens(avg) },
          { label: 'Latest', value: fmtTokens(baselines[0].baselineTokens) },
        ].map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg px-3 py-2.5 text-center"
            style={{ background: 'oklch(0.09 0 0)' }}
          >
            <p className="text-base font-mono font-semibold text-muted-foreground/60">
              {stat.value}
            </p>
            <p className="text-[9px] text-muted-foreground/25 mt-0.5 uppercase tracking-widest">
              {stat.label}
            </p>
          </div>
        ))}
      </div>

      {/* Sparkline */}
      <div
        className="rounded-lg px-4 py-3 flex flex-col gap-2"
        style={{ background: 'oklch(0.09 0 0)' }}
      >
        <p className="text-[9px] text-muted-foreground/25 uppercase tracking-widest">
          Token baseline trend (newest → oldest)
        </p>
        <Sparkline data={baselines} />
        <div className="flex justify-between">
          <span className="text-[9px] font-mono text-muted-foreground/20">
            min {fmtTokens(minVal)}
          </span>
          <span className="text-[9px] font-mono text-muted-foreground/20">
            max {fmtTokens(maxVal)}
          </span>
        </div>
      </div>

      {/* Session table */}
      <div className="flex flex-col gap-px">
        <div
          className="grid grid-cols-[1fr_auto] gap-4 px-3 py-1.5"
          style={{ borderBottom: '1px solid oklch(0.13 0 0)' }}
        >
          <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/20">
            Session date
          </span>
          <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/20 text-right">
            Baseline tokens
          </span>
        </div>
        {baselines.map((b, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_auto] gap-4 px-3 py-2 rounded"
            style={{ background: i % 2 === 0 ? 'oklch(0.085 0 0)' : 'transparent' }}
          >
            <span className="text-[11px] font-mono text-muted-foreground/40">
              {new Date(b.date).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <span
              className="text-[11px] font-mono font-semibold text-right"
              style={{
                color:
                  b.baselineTokens > 50_000
                    ? 'oklch(0.72 0.18 60 / 0.8)'
                    : 'oklch(0.65 0.15 140 / 0.8)',
              }}
            >
              {fmtTokens(b.baselineTokens)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Settings tab ─────────────────────────────────────────────────────────────

/** Recommended values and descriptions for each TOKEN_RELEVANT_ENV_VAR. */
const ENV_META: Record<string, { description: string; recommended?: string; neutral?: boolean }> = {
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: {
    description: 'Auto-compact threshold (default ~95)',
    recommended: '70',
  },
  ENABLE_TOOL_SEARCH: {
    description: 'Defer MCP tool defs — ~85% MCP token savings',
    recommended: '1',
  },
  CLAUDE_CODE_MAX_THINKING_TOKENS: {
    description: 'Extended thinking budget (default 10 000)',
    neutral: true,
  },
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: {
    description: 'Max output per response (default 16 000)',
    neutral: true,
  },
  MAX_MCP_OUTPUT_TOKENS: {
    description: 'Per-tool output limit (default 25 000)',
    neutral: true,
  },
  BASH_MAX_OUTPUT_LENGTH: {
    description: 'Bash stdout capture limit',
    neutral: true,
  },
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: {
    description: 'Disable auto-memory writes (reduces write tool overhead)',
    neutral: true,
  },
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: {
    description: 'Disable adaptive thinking depth',
    neutral: true,
  },
};

function SettingsTab({ settings }: { settings: AnalysisResult['settings'] }) {
  const { pluginCount, hasPreCompactHook, hasPostToolUseHook, envVars, hasClaudeIgnore } = settings;

  const hookRows = [
    {
      label: 'PreCompact hook',
      value: hasPreCompactHook ? 'Set' : 'Missing',
      ok: hasPreCompactHook,
    },
    {
      label: 'PostToolUse hook',
      value: hasPostToolUseHook ? 'Set' : 'Missing',
      ok: hasPostToolUseHook,
    },
    {
      label: '.claudeignore',
      value: hasClaudeIgnore ? 'Present' : 'Not found',
      ok: hasClaudeIgnore,
    },
    {
      label: 'Plugins / MCP servers',
      value: pluginCount === 0 ? 'None' : String(pluginCount),
      ok: pluginCount === 0,
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Hooks & file status */}
      <div className="flex flex-col gap-1.5">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/25 mb-1">
          Hooks &amp; files
        </p>
        {hookRows.map((row) => (
          <div
            key={row.label}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
            style={{ background: 'oklch(0.09 0 0)' }}
          >
            <div
              className="h-1.5 w-1.5 rounded-full shrink-0"
              style={{
                background: row.ok ? 'oklch(0.65 0.15 140)' : 'oklch(0.72 0.18 60)',
              }}
            />
            <p className="text-[11px] text-muted-foreground/50 flex-1 min-w-0 font-mono truncate">
              {row.label}
            </p>
            <p
              className="text-[11px] font-mono shrink-0"
              style={{
                color: row.ok ? 'oklch(0.65 0.15 140 / 0.7)' : 'oklch(0.72 0.18 60 / 0.7)',
              }}
            >
              {row.value}
            </p>
          </div>
        ))}
      </div>

      {/* Full env vars audit table */}
      <div className="flex flex-col gap-1.5">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/25 mb-1">
          Token-relevant env vars (settings.json)
        </p>
        {/* Header */}
        <div
          className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-1.5"
          style={{ borderBottom: '1px solid oklch(0.13 0 0)' }}
        >
          {['Variable', 'Current', 'Recommended'].map((h) => (
            <span
              key={h}
              className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/20 last:text-right"
            >
              {h}
            </span>
          ))}
        </div>
        {TOKEN_RELEVANT_ENV_VARS.map((key, i) => {
          const meta = ENV_META[key];
          const current = envVars[key];
          const isSet = current !== undefined;
          const rec = meta?.recommended;
          // ok = set and matches recommendation (if one exists), or neutral and set
          const ok = isSet && (rec == null || current === rec);
          const needs = !isSet && rec != null;

          return (
            <div
              key={key}
              className="grid grid-cols-[1fr_auto_auto] gap-3 px-3 py-2 rounded"
              style={{ background: i % 2 === 0 ? 'oklch(0.085 0 0)' : 'transparent' }}
            >
              <div className="min-w-0">
                <p className="text-[10px] font-mono text-muted-foreground/45 truncate">{key}</p>
                {meta && (
                  <p className="text-[9px] text-muted-foreground/20 leading-snug mt-0.5 truncate">
                    {meta.description}
                  </p>
                )}
              </div>
              <span
                className="text-[10px] font-mono self-center text-right"
                style={{
                  color: ok
                    ? 'oklch(0.65 0.15 140 / 0.7)'
                    : isSet
                      ? 'oklch(0.72 0.18 60 / 0.7)'
                      : 'oklch(0.45 0 0)',
                }}
              >
                {isSet ? current : '—'}
              </span>
              <span
                className="text-[10px] font-mono self-center text-right"
                style={{
                  color: needs ? 'oklch(0.68 0.16 55 / 0.6)' : 'oklch(0.35 0 0)',
                }}
              >
                {rec ?? '—'}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-[10px] text-muted-foreground/25 leading-relaxed">
        Edit these settings in{' '}
        <Link
          href="/settings?tab=config"
          className="underline underline-offset-2 hover:text-muted-foreground/50 transition-colors"
        >
          ~/.claude/settings.json
        </Link>{' '}
        via the Config editor.
      </p>
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export function AnalyzeDashboardClient({ projects }: Props) {
  const router = useRouter();
  const [scope, setScope] = useState('global');
  const [state, setState] = useState<DashboardState>({ phase: 'idle' });
  const [fixingAction, setFixingAction] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const runAnalysis = useCallback(async (currentScope: string) => {
    setState({ phase: 'loading' });
    try {
      const res = await fetch('/api/config/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: currentScope }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: AnalysisResult };
      setState({ phase: 'done', result: body.data });
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'Analysis failed',
      });
    }
  }, []);

  // Auto-run on mount and on scope change
  useEffect(() => {
    void runAnalysis(scope);
  }, [runAnalysis, scope]);

  const handleFix = useCallback(
    async (action: NonNullable<Suggestion['action']>, value?: string) => {
      setFixingAction(action);
      try {
        const res = await fetch('/api/config/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, value }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Re-run analysis to refresh results
        await runAnalysis(scope);
      } catch {
        // Best-effort — still refresh
        await runAnalysis(scope);
      } finally {
        setFixingAction(null);
      }
    },
    [scope, runAnalysis],
  );

  const handleAiAnalysis = useCallback(async () => {
    setLaunching(true);
    setLaunchError(null);
    try {
      const res = await fetch('/api/config/analyze/ai-session', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { data: { sessionId: string } };
      router.push(`/sessions/${body.data.sessionId}`);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Failed to launch');
      setLaunching(false);
    }
  }, [router]);

  const actionableSuggestions = useMemo(() => {
    if (state.phase !== 'done') return [];
    return state.result.suggestions;
  }, [state]);

  const isLoading = state.phase === 'loading' || fixingAction !== null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Page header ──────────────────────────────────────────────── */}
      <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.09_0_0)] overflow-hidden shrink-0 mb-4 sm:mb-5">
        <div
          className="h-[2px] w-full"
          style={{
            background:
              'linear-gradient(90deg, oklch(0.68 0.16 55 / 0.6) 0%, oklch(0.62 0.13 225 / 0.1) 100%)',
          }}
        />
        <div className="flex items-center gap-3 px-4 py-3">
          <div
            className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0"
            style={{
              background:
                'linear-gradient(135deg, oklch(0.68 0.16 55 / 0.15) 0%, oklch(0.62 0.13 225 / 0.08) 100%)',
              border: '1px solid oklch(0.68 0.16 55 / 0.12)',
            }}
          >
            <BarChart2 className="h-4 w-4" style={{ color: 'oklch(0.68 0.16 55 / 0.8)' }} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-foreground/90">Token Analyzer</h1>
            <p className="text-[11px] text-muted-foreground/35 mt-0.5">
              Deep analysis of your Claude context budget with one-click fixes
            </p>
          </div>

          {/* Back link */}
          <Link
            href="/settings?tab=config"
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground/35 hover:text-muted-foreground/65 transition-colors shrink-0"
          >
            <ArrowLeft className="h-3 w-3" />
            Config
          </Link>
        </div>
      </div>

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <div
        className="rounded-xl border border-white/[0.06] overflow-hidden shrink-0 mb-3"
        style={{ background: 'oklch(0.08 0 0)' }}
      >
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="w-48 shrink-0">
              <ConfigScopeSelector scope={scope} projects={projects} onChange={setScope} />
            </div>
            <div className="flex-1" />

            {/* Refresh static analysis */}
            <button
              type="button"
              disabled={isLoading || launching}
              onClick={() => void runAnalysis(scope)}
              title="Refresh"
              className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors disabled:opacity-30"
              style={{ background: 'oklch(0.10 0 0)' }}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>

            {/* AI Deep Analysis */}
            <button
              type="button"
              disabled={launching || isLoading}
              onClick={() => void handleAiAnalysis()}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all',
                'disabled:opacity-50',
              )}
              style={{
                background: launching
                  ? 'oklch(0.62 0.13 285 / 0.1)'
                  : 'oklch(0.62 0.13 285 / 0.15)',
                color: 'oklch(0.72 0.13 285 / 0.9)',
                border: '1px solid oklch(0.62 0.13 285 / 0.2)',
              }}
            >
              {launching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              {launching ? 'Launching…' : 'AI Deep Analysis'}
            </button>
          </div>

          {/* Launch error */}
          {launchError && <p className="text-[11px] text-red-400/60 text-right">{launchError}</p>}
        </div>
      </div>

      {/* ── Main content ───────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {state.phase === 'loading' && (
          <div className="flex flex-col items-center gap-3 py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground/30">Scanning…</p>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-6 w-6 text-red-400/50" />
            <p className="text-sm text-red-400/60">{state.message}</p>
            <button
              type="button"
              onClick={() => void runAnalysis(scope)}
              className="text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors underline underline-offset-2"
            >
              Try again
            </button>
          </div>
        )}

        {state.phase === 'done' && (
          <div
            className="rounded-xl border border-white/[0.06] overflow-hidden"
            style={{ background: 'oklch(0.075 0 0)' }}
          >
            <Tabs defaultValue="overview">
              <div
                className="px-4 pt-3 pb-0 border-b shrink-0"
                style={{ borderColor: 'oklch(0.13 0 0)' }}
              >
                <TabsList className="h-8 bg-transparent gap-1 mb-0 p-0">
                  {[
                    { value: 'overview', icon: BarChart2, label: 'Overview' },
                    { value: 'quickwins', icon: Zap, label: 'Quick Wins' },
                    { value: 'trends', icon: TrendingUp, label: 'Trends' },
                    { value: 'settings', icon: Settings2, label: 'Settings' },
                  ].map(({ value, icon: Icon, label }) => (
                    <TabsTrigger
                      key={value}
                      value={value}
                      className="h-8 text-xs px-3 rounded-none border-b-2 border-transparent data-[state=active]:border-b-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground/80 text-muted-foreground/40 hover:text-muted-foreground/60 transition-colors"
                    >
                      <Icon className="h-3 w-3 mr-1.5" />
                      {label}
                      {value === 'quickwins' &&
                        actionableSuggestions.filter((s) => s.action).length > 0 && (
                          <span
                            className="ml-1.5 text-[9px] px-1.5 py-px rounded-full font-mono"
                            style={{
                              background: 'oklch(0.68 0.16 55 / 0.15)',
                              color: 'oklch(0.68 0.16 55 / 0.7)',
                            }}
                          >
                            {actionableSuggestions.filter((s) => s.action).length}
                          </span>
                        )}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              <div className="p-5">
                <TabsContent value="overview" className="mt-0">
                  <OverviewTab result={state.result} />
                </TabsContent>

                <TabsContent value="quickwins" className="mt-0">
                  <QuickWinsTab
                    suggestions={state.result.suggestions}
                    onFix={handleFix}
                    fixingAction={fixingAction}
                  />
                </TabsContent>

                <TabsContent value="trends" className="mt-0">
                  <TrendsTab baselines={state.result.sessionBaselines} />
                </TabsContent>

                <TabsContent value="settings" className="mt-0">
                  <SettingsTab settings={state.result.settings} />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  );
}
