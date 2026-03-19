'use client';

import { useState } from 'react';
import { GitBranch, GitFork, ChevronDown, ChevronRight } from 'lucide-react';
import type { GitContextSnapshot } from '@/lib/realtime/event-types';

interface GitContextSectionProps {
  snapshot: GitContextSnapshot | null;
  capturedAt?: string;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function FileStatusIcon({ status }: { status: 'M' | 'A' | '?' }) {
  const colors: Record<string, string> = {
    M: 'text-amber-400',
    A: 'text-emerald-400',
    '?': 'text-zinc-500',
  };
  return <span className={`font-mono text-xs font-bold ${colors[status]}`}>{status}</span>;
}

export function GitContextSection({ snapshot, capturedAt }: GitContextSectionProps) {
  const [filesExpanded, setFilesExpanded] = useState(false);

  if (snapshot === null) {
    return (
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mb-2 font-medium flex items-center gap-1.5">
          <GitBranch className="h-3 w-3" />
          Git Context
        </h3>
        <p className="text-xs text-muted-foreground/30">Not a git repository</p>
      </div>
    );
  }

  const {
    branch,
    commitHash,
    commitMessage,
    isDirty,
    isWorktree,
    baseBranch,
    untrackedCount,
    stagedFiles,
    modifiedFiles,
    commitsSinceStart,
    aheadBehind,
  } = snapshot;

  const modifiedCount = modifiedFiles.length;
  const stagedCount = stagedFiles.length;
  const totalFiles = modifiedCount + stagedCount + untrackedCount;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground/50 font-medium flex items-center gap-1.5">
          <GitBranch className="h-3 w-3" />
          Git Context
        </h3>
        {capturedAt && (
          <span className="text-[10px] text-muted-foreground/30" suppressHydrationWarning>
            Updated {timeAgo(capturedAt)}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        {/* Branch */}
        <div>
          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Branch</p>
          <p className="mt-0.5 font-mono text-sm text-cyan-400 truncate">{branch}</p>
        </div>

        {/* Commit */}
        <div>
          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Commit</p>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="font-mono text-xs text-muted-foreground/60">{commitHash}</span>
            <span className="text-xs text-muted-foreground/40 truncate">{commitMessage}</span>
          </div>
        </div>

        {/* Status */}
        <div className="col-span-2">
          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Status</p>
          <div className="mt-0.5 flex items-center gap-2">
            <span
              className={`inline-block h-2 w-2 rounded-full ${isDirty ? 'bg-amber-400' : 'bg-emerald-400'}`}
            />
            {isDirty ? (
              <span className="text-xs text-muted-foreground/60">
                {modifiedCount > 0 && `${modifiedCount} modified`}
                {modifiedCount > 0 && (stagedCount > 0 || untrackedCount > 0) && ', '}
                {stagedCount > 0 && `${stagedCount} staged`}
                {stagedCount > 0 && untrackedCount > 0 && ', '}
                {untrackedCount > 0 && `${untrackedCount} untracked`}
              </span>
            ) : (
              <span className="text-xs text-emerald-400/70">Clean</span>
            )}
          </div>
        </div>

        {/* Worktree */}
        <div>
          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Worktree</p>
          {isWorktree ? (
            <p className="mt-0.5 text-xs text-cyan-300/70 flex items-center gap-1">
              <GitFork className="h-3 w-3" />
              Yes{baseBranch ? ` (from ${baseBranch})` : ''}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-muted-foreground/30">No</p>
          )}
        </div>

        {/* Remote */}
        {aheadBehind && (
          <div>
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Remote</p>
            <p className="mt-0.5 text-xs">
              {aheadBehind.ahead === 0 && aheadBehind.behind === 0 ? (
                <span className="text-muted-foreground/40">In sync</span>
              ) : (
                <>
                  {aheadBehind.ahead > 0 && (
                    <span className="text-emerald-400">↑{aheadBehind.ahead}</span>
                  )}
                  {aheadBehind.ahead > 0 && aheadBehind.behind > 0 && ' '}
                  {aheadBehind.behind > 0 && (
                    <span className="text-amber-400">↓{aheadBehind.behind}</span>
                  )}
                </>
              )}
            </p>
          </div>
        )}

        {/* Session Delta */}
        {commitsSinceStart != null && commitsSinceStart > 0 && (
          <div className="col-span-2">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">
              Session Δ
            </p>
            <p className="mt-0.5 text-xs text-emerald-400">
              +{commitsSinceStart} commit{commitsSinceStart !== 1 ? 's' : ''} since start
            </p>
          </div>
        )}
      </div>

      {/* Collapsible file list */}
      {isDirty && totalFiles > 0 && (
        <div className="mt-3 pt-3 border-t border-white/[0.06]">
          <button
            type="button"
            onClick={() => setFilesExpanded((prev) => !prev)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground/80 transition-colors"
          >
            {filesExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {modifiedCount > 0 && `${modifiedCount} modified`}
            {modifiedCount > 0 && (stagedCount > 0 || untrackedCount > 0) && ', '}
            {stagedCount > 0 && `${stagedCount} staged`}
            {stagedCount > 0 && untrackedCount > 0 && ', '}
            {untrackedCount > 0 && `${untrackedCount} untracked`}
          </button>

          {filesExpanded && (
            <div className="mt-2 flex flex-col gap-0.5">
              {modifiedFiles.map((file) => (
                <div key={`M:${file}`} className="flex items-center gap-2">
                  <FileStatusIcon status="M" />
                  <span className="font-mono text-xs text-muted-foreground/60 truncate">
                    {file}
                  </span>
                </div>
              ))}
              {stagedFiles.map((file) => (
                <div key={`A:${file}`} className="flex items-center gap-2">
                  <FileStatusIcon status="A" />
                  <span className="font-mono text-xs text-muted-foreground/60 truncate">
                    {file}
                  </span>
                </div>
              ))}
              {untrackedCount > 0 && (
                <div className="flex items-center gap-2">
                  <FileStatusIcon status="?" />
                  <span className="font-mono text-xs text-muted-foreground/40">
                    {untrackedCount} untracked file{untrackedCount !== 1 ? 's' : ''}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
