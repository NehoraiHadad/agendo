'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import { diffLines } from '@/lib/utils/diff-lines';

interface PlanDiffCardProps {
  id: string;
  currentContent: string;
  suggestedContent: string;
  status: 'pending' | 'applied' | 'skipped';
  onApply: () => void;
  onSkip: () => void;
}

const MAX_VISIBLE_LINES = 15;

export function PlanDiffCard({
  currentContent,
  suggestedContent,
  status,
  onApply,
  onSkip,
}: PlanDiffCardProps) {
  const [showAll, setShowAll] = useState(false);

  if (status === 'applied') {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/[0.06] border border-emerald-500/20 text-xs text-emerald-400/80">
        <Check className="size-3 shrink-0" />
        <span>Edit applied</span>
      </div>
    );
  }

  if (status === 'skipped') {
    return (
      <div className="px-3 py-2 rounded-lg text-xs text-muted-foreground/40 border border-white/[0.04]">
        <span>Skipped</span>
      </div>
    );
  }

  const diff = diffLines(currentContent, suggestedContent);
  const hasMore = diff.length > MAX_VISIBLE_LINES;
  const visibleDiff = showAll ? diff : diff.slice(0, MAX_VISIBLE_LINES);
  const hiddenCount = diff.length - MAX_VISIBLE_LINES;

  return (
    <div className="rounded-lg border border-white/[0.07] overflow-hidden border-l-2 border-l-amber-500/60">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/[0.04] border-b border-amber-500/10">
        <span className="text-xs font-medium text-amber-400/80">Suggested Edit</span>
        <span className="text-[10px] bg-amber-500/15 text-amber-400/70 border border-amber-500/20 rounded-full px-2 py-0.5 font-medium">
          diff
        </span>
      </div>

      {/* Diff body */}
      <div className="font-mono text-[11px] overflow-x-auto">
        {visibleDiff.map((line, idx) => {
          if (line.type === 'remove') {
            return (
              <div
                key={idx}
                className="px-3 py-0.5 bg-red-500/[0.08] text-red-300/80 line-through decoration-red-400/40 whitespace-pre"
              >
                <span className="select-none text-red-400/40 mr-2">-</span>
                {line.text}
              </div>
            );
          }
          if (line.type === 'add') {
            return (
              <div
                key={idx}
                className="px-3 py-0.5 bg-emerald-500/[0.08] text-emerald-300/80 whitespace-pre"
              >
                <span className="select-none text-emerald-400/40 mr-2">+</span>
                {line.text}
              </div>
            );
          }
          return (
            <div key={idx} className="px-3 py-0.5 text-foreground/40 whitespace-pre">
              <span className="select-none mr-2"> </span>
              {line.text}
            </div>
          );
        })}

        {hasMore && !showAll && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full px-3 py-1.5 text-left text-[11px] text-amber-400/60 hover:text-amber-400/80 hover:bg-amber-500/[0.04] transition-colors border-t border-white/[0.04]"
          >
            Show {hiddenCount} more {hiddenCount === 1 ? 'line' : 'lines'}
          </button>
        )}
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-white/[0.05] bg-white/[0.01]">
        <button
          type="button"
          onClick={onApply}
          className="text-xs px-3 py-1 rounded-md font-medium transition-colors"
          style={{
            background:
              'linear-gradient(135deg, oklch(0.72 0.18 65 / 0.25) 0%, oklch(0.65 0.16 60 / 0.18) 100%)',
            border: '1px solid oklch(0.72 0.18 65 / 0.35)',
            color: 'oklch(0.85 0.12 75)',
          }}
        >
          Apply
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="text-xs px-3 py-1 rounded-md text-muted-foreground/50 hover:text-muted-foreground/70 hover:bg-white/[0.04] transition-colors"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
