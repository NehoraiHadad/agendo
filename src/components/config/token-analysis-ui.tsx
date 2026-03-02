'use client';

/**
 * Shared React components for token analysis UI.
 * Used by both the TokenBudgetPanel (config editor empty state)
 * and the /config/analyze dashboard.
 */

import { useMemo, useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type BudgetFile, type Suggestion, alpha, fmtTokens } from '@/lib/utils/token-analysis';

// ─── Bar segment ─────────────────────────────────────────────────────────────

export interface BarSegmentProps {
  color: string;
  width: number;
  delay: number;
  label: string;
  tokens: number;
  dashed?: boolean;
}

export function BarSegment({ color, width, delay, label, tokens, dashed }: BarSegmentProps) {
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
        background: dashed
          ? `repeating-linear-gradient(45deg, ${color}, ${color} 3px, transparent 3px, transparent 6px)`
          : color,
        boxShadow: dashed ? 'none' : `0 0 8px ${alpha(color, 0.3)}`,
        opacity: dashed ? 0.6 : 1,
        transition: 'transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)',
        transformOrigin: 'left',
        transform: drawn ? 'scaleX(1)' : 'scaleX(0)',
      }}
    />
  );
}

// ─── Category row ─────────────────────────────────────────────────────────────

export interface CategoryRowProps {
  label: string;
  description: string;
  color: string;
  tokens: number;
  invokeTokens: number;
  files: BudgetFile[];
  badge?: string;
  isExpanded: boolean;
  onToggle: (() => void) | null;
}

export function CategoryRow({
  label,
  description,
  color,
  tokens,
  invokeTokens,
  files,
  badge,
  isExpanded,
  onToggle,
}: CategoryRowProps) {
  const sorted = useMemo(
    () => [...files].sort((a, b) => b.tokens + b.invokeTokens - (a.tokens + a.invokeTokens)),
    [files],
  );

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ background: 'oklch(0.095 0 0)', borderLeft: `2px solid ${alpha(color, 0.75)}` }}
    >
      <button
        type="button"
        onClick={onToggle ?? undefined}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
          onToggle ? 'hover:bg-white/[0.025]' : 'cursor-default',
        )}
      >
        <span className="w-3 shrink-0 flex items-center justify-center">
          {onToggle ? (
            isExpanded ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground/25" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground/25" />
            )
          ) : null}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-[11px] font-medium text-muted-foreground/65">{label}</p>
            {badge && (
              <span
                className="text-[9px] px-1 py-px rounded"
                style={{ background: alpha(color, 0.1), color: alpha(color, 0.65) }}
              >
                {badge}
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground/25 mt-0.5 truncate">{description}</p>
        </div>

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

      {isExpanded && sorted.length > 0 && (
        <div
          className="px-3 pb-2 pt-1 flex flex-col gap-px"
          style={{ borderTop: '1px solid oklch(0.13 0 0)' }}
        >
          {sorted.map((f) => (
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

// ─── Suggestion card ──────────────────────────────────────────────────────────

export interface SuggestionCardProps {
  s: Suggestion;
  /** If provided, renders a "Fix →" button for suggestions that have an action. */
  onFix?: (action: NonNullable<Suggestion['action']>, value?: string) => void;
  isFixing?: boolean;
}

export function SuggestionCard({ s, onFix, isFixing }: SuggestionCardProps) {
  const [open, setOpen] = useState(false);

  const icon =
    s.level === 'warn' ? (
      <AlertTriangle className="h-3 w-3 shrink-0 mt-px" style={{ color: 'oklch(0.72 0.18 60)' }} />
    ) : s.level === 'good' ? (
      <CheckCircle2 className="h-3 w-3 shrink-0 mt-px" style={{ color: 'oklch(0.65 0.15 140)' }} />
    ) : (
      <Info className="h-3 w-3 shrink-0 mt-px" style={{ color: 'oklch(0.62 0.13 225)' }} />
    );

  const borderColor =
    s.level === 'warn'
      ? 'oklch(0.72 0.18 60 / 0.4)'
      : s.level === 'good'
        ? 'oklch(0.65 0.15 140 / 0.3)'
        : 'oklch(0.62 0.13 225 / 0.3)';

  const showFix = onFix && s.action && (open || s.level !== 'good');

  return (
    <div
      className="rounded-lg transition-colors"
      style={{ background: 'oklch(0.09 0 0)', borderLeft: `2px solid ${borderColor}` }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left px-3 py-2 hover:bg-white/[0.02] rounded-lg"
      >
        <div className="flex items-start gap-2">
          {icon}
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-muted-foreground/60 leading-snug">{s.title}</p>
            {(open || s.level === 'good') && (
              <p className="text-[10px] text-muted-foreground/35 mt-1 leading-relaxed">
                {s.detail}
              </p>
            )}
          </div>
          {s.savings != null && s.savings > 0 && (
            <span
              className="text-[9px] font-mono px-1.5 py-0.5 rounded shrink-0"
              style={{
                background: 'oklch(0.65 0.15 140 / 0.12)',
                color: 'oklch(0.65 0.15 140 / 0.7)',
              }}
            >
              -{fmtTokens(s.savings)}
            </span>
          )}
          {!open && s.level !== 'good' && (
            <ChevronRight className="h-3 w-3 text-muted-foreground/20 shrink-0 mt-px" />
          )}
        </div>
      </button>

      {showFix && s.action && (
        <div className="px-3 pb-2 flex justify-end">
          <button
            type="button"
            disabled={isFixing}
            onClick={() => onFix(s.action as NonNullable<Suggestion['action']>, s.actionValue)}
            className="text-[10px] px-2.5 py-1 rounded transition-colors disabled:opacity-40"
            style={{
              background: 'oklch(0.62 0.13 225 / 0.15)',
              color: 'oklch(0.62 0.13 225 / 0.8)',
            }}
          >
            {isFixing ? 'Applying…' : 'Fix →'}
          </button>
        </div>
      )}
    </div>
  );
}
