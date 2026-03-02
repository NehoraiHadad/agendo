'use client';

/**
 * Token budget analysis panel for the Config editor.
 *
 * Methodology based on token-optimizer by @alexgreensh
 * https://github.com/alexgreensh/token-optimizer
 * Licensed under Apache-2.0 (see NOTICE in source repo)
 */

import { useMemo, useState, useEffect } from 'react';
import { Puzzle } from 'lucide-react';
import { type TreeNode } from './config-file-tree';
import {
  SYSTEM_OVERHEAD,
  CONTEXT_WINDOW,
  MCP_TOKENS_PER_TOOL,
  MCP_TOOLS_PER_PLUGIN_EST,
  alpha,
  fmtTokens,
  computeMcpEstimate,
  computeCategories,
  computeSuggestions,
} from '@/lib/utils/token-analysis';
import { BarSegment, CategoryRow, SuggestionCard } from './token-analysis-ui';

// ─── Main component ──────────────────────────────────────────────────────────

interface TokenBudgetPanelProps {
  tree: TreeNode[];
  isProjectScope: boolean;
  globalTokens: number | null;
  alwaysTotal: number;
}

export function TokenBudgetPanel({
  tree,
  isProjectScope,
  globalTokens,
  alwaysTotal,
}: TokenBudgetPanelProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pluginCount, setPluginCount] = useState<number | null>(null);
  const [hasPreCompactHook, setHasPreCompactHook] = useState<boolean | null>(null);
  const [hasPostToolUseHook, setHasPostToolUseHook] = useState<boolean | null>(null);
  const [autocompactPct, setAutocompactPct] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config/files?path=' + encodeURIComponent('~/.claude/settings.json'))
      .then((r) => r.json() as Promise<{ data: { content: string } }>)
      .then((body) => {
        const settings = JSON.parse(body.data.content) as {
          enabledPlugins?: Record<string, boolean>;
          mcpServers?: Record<string, unknown>;
          hooks?: { PreCompact?: unknown; PostToolUse?: unknown };
          env?: Record<string, string>;
        };
        const plugins = Object.values(settings.enabledPlugins ?? {}).filter(Boolean).length;
        const mcpServers = Object.keys(settings.mcpServers ?? {}).length;
        setPluginCount(plugins + mcpServers);

        const preCompact = settings.hooks?.PreCompact;
        setHasPreCompactHook(Array.isArray(preCompact) ? preCompact.length > 0 : !!preCompact);

        const postToolUse = settings.hooks?.PostToolUse;
        setHasPostToolUseHook(Array.isArray(postToolUse) ? postToolUse.length > 0 : !!postToolUse);

        setAutocompactPct(settings.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? null);
      })
      .catch(() => {
        setPluginCount(0);
        setHasPreCompactHook(false);
        setHasPostToolUseHook(false);
        setAutocompactPct(null);
      });
  }, []);

  const categories = useMemo(() => computeCategories(tree), [tree]);
  const mcpEstimate = computeMcpEstimate(pluginCount ?? 0);

  const invokeTotal = useMemo(
    () => categories.reduce((s, c) => s + c.invokeTokens, 0),
    [categories],
  );

  const suggestions = useMemo(
    () =>
      computeSuggestions({
        categories,
        pluginCount,
        hasPreCompactHook,
        hasPostToolUseHook,
        autocompactPct,
      }),
    [categories, pluginCount, hasPreCompactHook, hasPostToolUseHook, autocompactPct],
  );

  const contextPct = alwaysTotal / CONTEXT_WINDOW;
  const totalColor =
    contextPct > 0.15
      ? 'oklch(0.65 0.22 25)'
      : contextPct > 0.05
        ? 'oklch(0.72 0.18 60)'
        : 'oklch(0.65 0.15 140)';

  // Bar colours
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

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  const warnCount = suggestions.filter((s) => s.level === 'warn').length;

  return (
    <div className="flex flex-col h-full overflow-y-auto min-h-0">
      <div className="flex flex-col gap-5 p-5 flex-1 min-w-0">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-end justify-between gap-4 min-w-0">
          <div className="min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/25 mb-1.5">
              Context Budget
            </p>
            <div className="flex items-baseline gap-2.5 flex-wrap">
              <span
                className="text-3xl font-mono font-bold tracking-tight tabular-nums"
                style={{
                  color: totalColor,
                  textShadow: `0 0 24px ${alpha(totalColor, 0.35)}`,
                }}
              >
                {fmtTokens(alwaysTotal)}
              </span>
              <span className="text-xs font-mono text-muted-foreground/30 whitespace-nowrap">
                / 200K &nbsp;·&nbsp; {(contextPct * 100).toFixed(1)}% used
              </span>
            </div>
            {mcpEstimate > 0 && (
              <p className="text-[10px] font-mono text-muted-foreground/20 mt-0.5">
                +{fmtTokens(mcpEstimate)} MCP est. → full est.{' '}
                {fmtTokens(alwaysTotal + mcpEstimate)}
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

        {/* ── Stacked bar ──────────────────────────────────────────────── */}
        <div>
          <div
            className="flex h-2.5 rounded-full overflow-hidden"
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

        {/* ── Divider ──────────────────────────────────────────────────── */}
        <div className="h-px" style={{ background: 'oklch(0.14 0 0)' }} />

        {/* ── Category rows ─────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          {/* System */}
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

          {/* Global (project scope only) */}
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

          {/* Data categories */}
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

          {/* On-invoke summary */}
          {invokeTotal > 0 && (
            <div
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
              style={{ background: 'oklch(0.09 0 0)', border: '1px dashed oklch(0.17 0 0)' }}
            >
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-muted-foreground/35">On invoke only</p>
                <p className="text-[10px] text-muted-foreground/20 mt-0.5">
                  Skill & command bodies — not loaded until explicitly invoked
                </p>
              </div>
              <span className="text-sm font-mono text-muted-foreground/25 shrink-0">
                +{fmtTokens(invokeTotal)}↗
              </span>
            </div>
          )}

          {/* MCP / Plugins */}
          <div
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
            style={{
              background: 'oklch(0.09 0 0)',
              borderLeft: `2px solid ${alpha(mcpColor, 0.5)}`,
            }}
          >
            <Puzzle className="h-3.5 w-3.5 shrink-0" style={{ color: alpha(mcpColor, 0.4) }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-[11px] text-muted-foreground/45">MCP & Plugins</p>
                {pluginCount != null && pluginCount > 0 && (
                  <span
                    className="text-[9px] px-1 rounded"
                    style={{ background: alpha(mcpColor, 0.12), color: alpha(mcpColor, 0.65) }}
                  >
                    {pluginCount}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/20 mt-0.5">
                {pluginCount === null
                  ? 'Loading…'
                  : pluginCount === 0
                    ? 'No servers or plugins configured'
                    : `~500 base + ${pluginCount} × ~${MCP_TOOLS_PER_PLUGIN_EST} tools × ${MCP_TOKENS_PER_TOOL} + ~75 instructions/server`}
              </p>
            </div>
            <span
              className="text-sm font-mono font-semibold shrink-0"
              style={{ color: alpha(mcpColor, pluginCount ? 0.7 : 0.3) }}
            >
              {pluginCount === null ? '…' : pluginCount === 0 ? '—' : fmtTokens(mcpEstimate)}
            </span>
          </div>
        </div>

        {/* ── Suggestions ──────────────────────────────────────────────── */}
        {suggestions.length > 0 && (
          <>
            <div className="h-px" style={{ background: 'oklch(0.14 0 0)' }} />
            <div>
              <div className="flex items-center gap-2 mb-2">
                <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/25">
                  Suggestions
                </p>
                {warnCount > 0 && (
                  <span
                    className="text-[9px] px-1.5 py-px rounded-full font-mono"
                    style={{
                      background: 'oklch(0.72 0.18 60 / 0.15)',
                      color: 'oklch(0.72 0.18 60 / 0.7)',
                    }}
                  >
                    {warnCount} actionable
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {suggestions.map((s, i) => (
                  <SuggestionCard key={i} s={s} />
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <p className="text-[9px] text-muted-foreground/15 text-center pb-1 mt-auto leading-relaxed">
          Select a file from the tree to edit · Estimates use chars ÷ 4
          <br />
          <a
            href="https://github.com/alexgreensh/token-optimizer"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-muted-foreground/30 transition-colors"
          >
            Methodology: token-optimizer by @alexgreensh
          </a>
        </p>
      </div>
    </div>
  );
}
