'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import type { ParsedDiff, DiffHunk } from '@/lib/diff-parser';

interface DiffViewProps {
  parsedDiff: ParsedDiff;
  filePath?: string;
  collapsible?: boolean;
}

function HunkBlock({ hunk, index }: { hunk: DiffHunk; index: number }) {
  const type = hunk.lines[0]?.type ?? 'unchanged';
  const isUnchanged = type === 'unchanged';
  const [expanded, setExpanded] = useState(!isUnchanged);

  if (isUnchanged && hunk.lines.length > 3) {
    return (
      <div>
        {expanded ? (
          <>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="flex items-center gap-1 w-full px-2 py-0.5 text-xs text-muted-foreground/50 hover:bg-white/[0.04] transition-colors"
            >
              <ChevronDown className="size-3" />
              <span>Collapse {hunk.lines.length} unchanged lines</span>
            </button>
            {hunk.lines.map((line, i) => (
              <div key={i} className="flex font-mono text-xs bg-white/[0.02]">
                <span className="select-none w-8 shrink-0 text-right pr-2 text-muted-foreground/30 border-r border-white/[0.06] py-px">
                  {i + 1}
                </span>
                <span className="px-2 py-px text-muted-foreground/50 whitespace-pre">
                  {line.content}
                </span>
              </div>
            ))}
          </>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex items-center gap-1 w-full px-2 py-0.5 text-xs text-muted-foreground/50 hover:bg-white/[0.04] transition-colors"
          >
            <ChevronRight className="size-3" />
            <span>{hunk.lines.length} unchanged lines</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      {hunk.lines.map((line, i) => {
        const prefix =
          line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
        const bgClass =
          line.type === 'added'
            ? 'bg-[oklch(0.25_0.08_145/0.4)] text-[oklch(0.8_0.15_145)]'
            : line.type === 'removed'
              ? 'bg-[oklch(0.25_0.08_22/0.4)] text-[oklch(0.8_0.15_22)]'
              : 'bg-white/[0.02] text-muted-foreground';
        return (
          <div
            key={`${index}-${i}`}
            className={`flex font-mono text-xs ${bgClass}`}
          >
            <span className={`select-none w-5 shrink-0 text-center border-r border-white/[0.06] py-px ${
              line.type === 'added'
                ? 'text-[oklch(0.7_0.15_145)] opacity-80'
                : line.type === 'removed'
                  ? 'text-[oklch(0.7_0.15_22)] opacity-80'
                  : 'text-muted-foreground/20'
            }`}>
              {prefix}
            </span>
            <span className="px-2 py-px whitespace-pre break-all">
              {line.content}
            </span>
          </div>
        );
      })}
    </>
  );
}

export function DiffView({
  parsedDiff,
  filePath,
  collapsible: _collapsible,
}: DiffViewProps) {
  const { hunks, additions, deletions } = parsedDiff;

  // Build full diff text for copy button
  const fullDiffText = hunks
    .flatMap((h) =>
      h.lines.map((l) => {
        const prefix =
          l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' ';
        return `${prefix}${l.content}`;
      }),
    )
    .join('\n');

  return (
    <div className="rounded border border-white/[0.08] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-2 py-1.5 bg-white/[0.03] border-b border-white/[0.06] text-xs">
        {filePath && (
          <span className="font-mono text-foreground/80 truncate flex-1">
            {filePath}
          </span>
        )}
        <span className="text-emerald-400 font-mono">+{additions}</span>
        <span className="text-red-400 font-mono">-{deletions}</span>
        <CopyButton text={fullDiffText} />
      </div>

      {/* Diff content */}
      <div className="max-h-[40dvh] overflow-auto">
        {hunks.map((hunk, i) => (
          <HunkBlock key={i} hunk={hunk} index={i} />
        ))}
        {hunks.length === 0 && (
          <div className="px-3 py-2 text-xs text-muted-foreground/50">No changes</div>
        )}
      </div>
    </div>
  );
}
