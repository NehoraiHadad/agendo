'use client';

import { useMemo, useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Puzzle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type TreeNode } from './config-file-tree';

// ─── Constants ───────────────────────────────────────────────────────────────

const SYSTEM_OVERHEAD = 15_000;
const CONTEXT_WINDOW = 200_000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n < 1000) return `~${n}`;
  return `~${(n / 1000).toFixed(1)}K`;
}

/** Inject alpha into an oklch() color string: "oklch(L C H)" → "oklch(L C H / α)" */
function alpha(color: string, a: number): string {
  return color.replace(')', ` / ${a})`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface BudgetFile {
  name: string;
  path: string;
  tokens: number;
  invokeTokens: number;
}

interface CategoryData {
  key: string;
  label: string;
  color: string;
  description: string;
  tokens: number;
  invokeTokens: number;
  files: BudgetFile[];
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

function computeCategories(tree: TreeNode[]): CategoryData[] {
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

// ─── Sub-components ───────────────────────────────────────────────────────────

interface BarSegmentProps {
  color: string;
  width: number; // percentage
  delay: number; // ms
  label: string;
  tokens: number;
}

function BarSegment({ color, width, delay, label, tokens }: BarSegmentProps) {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), delay + 60);
    return () => clearTimeout(t);
  }, [delay]);

  return (
    <div
      title={`${label}: ${fmtTokens(tokens)}`}
      style={{
        width: `${width}%`,
        minWidth: '2px',
        background: color,
        boxShadow: `0 0 8px ${alpha(color, 0.35)}`,
        transition: 'transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)',
        transformOrigin: 'left',
        transform: drawn ? 'scaleX(1)' : 'scaleX(0)',
      }}
    />
  );
}

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

  // Fetch plugin count from settings.json
  useEffect(() => {
    fetch('/api/config/files?path=' + encodeURIComponent('~/.claude/settings.json'))
      .then((r) => r.json() as Promise<{ data: { content: string } }>)
      .then((body) => {
        const settings = JSON.parse(body.data.content) as {
          enabledPlugins?: Record<string, boolean>;
          mcpServers?: Record<string, unknown>;
        };
        const plugins = Object.values(settings.enabledPlugins ?? {}).filter(Boolean).length;
        const mcpServers = Object.keys(settings.mcpServers ?? {}).length;
        setPluginCount(plugins + mcpServers);
      })
      .catch(() => setPluginCount(0));
  }, []);

  const categories = useMemo(() => computeCategories(tree), [tree]);

  const invokeTotal = useMemo(
    () => categories.reduce((s, c) => s + c.invokeTokens, 0),
    [categories],
  );

  const contextPct = alwaysTotal / CONTEXT_WINDOW;
  const totalColor =
    contextPct > 0.15
      ? 'oklch(0.65 0.22 25)'
      : contextPct > 0.05
        ? 'oklch(0.72 0.18 60)'
        : 'oklch(0.65 0.15 140)';

  // Slices for the stacked bar
  const systemColor = 'oklch(0.60 0.17 285)';
  const globalColor = 'oklch(0.58 0.10 240)';

  const barTotal = alwaysTotal || 1;

  const barSlices = [
    { key: 'system', label: 'System', color: systemColor, tokens: SYSTEM_OVERHEAD },
    ...(isProjectScope && (globalTokens ?? 0) > 0
      ? [{ key: 'global', label: 'Global Config', color: globalColor, tokens: globalTokens ?? 0 }]
      : []),
    ...categories.map((c) => ({ key: c.key, label: c.label, color: c.color, tokens: c.tokens })),
  ];

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto min-h-0">
      <div className="flex flex-col gap-5 p-5 flex-1 min-w-0">
        {/* ── Header ──────────────────────────────────────────────────── */}
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

        {/* ── Stacked proportion bar ───────────────────────────────────── */}
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
              />
            ))}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-2.5">
            {barSlices.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 rounded-sm shrink-0" style={{ background: s.color }} />
                <span className="text-[9px] text-muted-foreground/35 tracking-wide">{s.label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Divider ─────────────────────────────────────────────────── */}
        <div className="h-px" style={{ background: 'oklch(0.14 0 0)' }} />

        {/* ── Category rows ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          {/* System (fixed, not expandable) */}
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
              isExpanded={expanded[cat.key] ?? false}
              onToggle={cat.files.length > 0 ? () => toggle(cat.key) : null}
            />
          ))}

          {/* On-invoke summary */}
          {invokeTotal > 0 && (
            <div
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
              style={{
                background: 'oklch(0.09 0 0)',
                border: '1px dashed oklch(0.17 0 0)',
              }}
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
              borderLeft: '2px solid oklch(0.45 0.06 300 / 0.5)',
            }}
          >
            <Puzzle className="h-3.5 w-3.5 text-muted-foreground/25 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-[11px] text-muted-foreground/45">MCP & Plugins</p>
                {pluginCount !== null && pluginCount > 0 && (
                  <span
                    className="text-[9px] px-1 rounded"
                    style={{
                      background: 'oklch(0.45 0.06 300 / 0.12)',
                      color: 'oklch(0.55 0.06 300 / 0.7)',
                    }}
                  >
                    {pluginCount}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground/20 mt-0.5">
                {pluginCount === null
                  ? 'Loading…'
                  : pluginCount === 0
                    ? 'No servers configured'
                    : `${pluginCount} enabled · tool definitions consume tokens (not counted here)`}
              </p>
            </div>
            <span className="text-[10px] text-muted-foreground/20 font-mono shrink-0">
              {pluginCount === null ? '…' : pluginCount === 0 ? '—' : 'varies'}
            </span>
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <p className="text-[9px] text-muted-foreground/15 text-center pb-1 mt-auto">
          Select a file from the tree to edit &nbsp;·&nbsp; Estimates use chars ÷ 4
        </p>
      </div>
    </div>
  );
}

// ─── CategoryRow ─────────────────────────────────────────────────────────────

interface CategoryRowProps {
  label: string;
  description: string;
  color: string;
  tokens: number;
  invokeTokens: number;
  files: BudgetFile[];
  isExpanded: boolean;
  onToggle: (() => void) | null;
}

function CategoryRow({
  label,
  description,
  color,
  tokens,
  invokeTokens,
  files,
  isExpanded,
  onToggle,
}: CategoryRowProps) {
  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => b.tokens + b.invokeTokens - (a.tokens + a.invokeTokens)),
    [files],
  );

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        background: 'oklch(0.095 0 0)',
        borderLeft: `2px solid ${alpha(color, 0.75)}`,
      }}
    >
      <button
        type="button"
        onClick={onToggle ?? undefined}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
          onToggle ? 'hover:bg-white/[0.025]' : 'cursor-default',
        )}
      >
        {/* Expand chevron */}
        <span className="w-3 shrink-0 flex items-center justify-center">
          {onToggle ? (
            isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground/25" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground/25" />
            )
          ) : null}
        </span>

        {/* Label + description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-[11px] font-medium text-muted-foreground/65">{label}</p>
            {files.length > 0 && (
              <span
                className="text-[9px] px-1 py-px rounded"
                style={{
                  background: alpha(color, 0.1),
                  color: alpha(color, 0.65),
                }}
              >
                {files.length}
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground/25 mt-0.5 truncate">{description}</p>
        </div>

        {/* Token counts */}
        <div className="text-right shrink-0">
          <p className="text-sm font-mono font-semibold" style={{ color: alpha(color, 0.85) }}>
            {fmtTokens(tokens)}
          </p>
          {invokeTokens > 0 && (
            <p className="text-[10px] font-mono text-muted-foreground/25">
              +{fmtTokens(invokeTokens)}↗
            </p>
          )}
        </div>
      </button>

      {/* File list */}
      {isExpanded && sortedFiles.length > 0 && (
        <div
          className="px-3 pb-2 pt-1 flex flex-col gap-px"
          style={{ borderTop: '1px solid oklch(0.13 0 0)' }}
        >
          {sortedFiles.map((f) => (
            <div
              key={f.path}
              className="flex items-center gap-2 py-1 px-2 rounded"
              style={{ background: 'oklch(0.085 0 0)' }}
            >
              <div
                className="h-1 w-1 rounded-full shrink-0"
                style={{ background: alpha(color, 0.4) }}
              />
              <span className="text-[10px] font-mono text-muted-foreground/45 flex-1 truncate">
                {f.name}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground/35 shrink-0">
                {fmtTokens(f.tokens)}
                {f.invokeTokens > 0 && (
                  <span className="text-muted-foreground/20 ml-1">
                    +{fmtTokens(f.invokeTokens)}↗
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
