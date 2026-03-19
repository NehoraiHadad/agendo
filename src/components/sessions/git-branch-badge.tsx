import { GitBranch, GitFork } from 'lucide-react';
import type { GitContextSnapshot } from '@/lib/realtime/event-types';

interface GitBranchBadgeProps {
  snapshot: GitContextSnapshot;
  onClick?: () => void;
}

export function GitBranchBadge({ snapshot, onClick }: GitBranchBadgeProps) {
  const shortHash = snapshot.commitHash.slice(0, 7);

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-mono border cursor-pointer bg-cyan-500/[0.06] border-cyan-500/[0.12] text-cyan-400 hover:bg-cyan-500/[0.12] transition-colors"
      title={`${snapshot.branch} @ ${snapshot.commitHash}${snapshot.isDirty ? ' (dirty)' : ''}${snapshot.isWorktree ? ' (worktree)' : ''}`}
    >
      <GitBranch className="size-3 shrink-0" />
      <span>{snapshot.branch}</span>
      {snapshot.isWorktree && <GitFork className="size-3 shrink-0 text-cyan-300/50" />}
      <span className="text-muted-foreground/40">/{shortHash}</span>
      {snapshot.isDirty && (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 ml-0.5 shrink-0" />
      )}
    </button>
  );
}
