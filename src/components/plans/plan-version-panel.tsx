'use client';

import { useState, useEffect, useCallback } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  X,
  Loader2,
  RotateCcw,
  GitCompareArrows,
  FileText,
  Clock,
  Bot,
  PenLine,
  MessageSquare,
  Terminal,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import { diffLines } from '@/lib/utils/diff-lines';
import { cn } from '@/lib/utils';
import type { PlanVersionMetadata } from '@/lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VersionSummary {
  id: string;
  version: number;
  title: string;
  createdAt: string;
  metadata: PlanVersionMetadata;
}

interface VersionDetail {
  id: string;
  planId: string;
  version: number;
  content: string;
  title: string;
  createdAt: string;
  metadata: PlanVersionMetadata;
}

// ---------------------------------------------------------------------------
// Source badge config
// ---------------------------------------------------------------------------

const SOURCE_CONFIG: Record<
  string,
  { label: string; icon: typeof Bot; color: string; bg: string; border: string }
> = {
  exitPlanMode: {
    label: 'Plan Mode',
    icon: Sparkles,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
  },
  manual_edit: {
    label: 'Manual',
    icon: PenLine,
    color: 'text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
  },
  conversation: {
    label: 'Chat',
    icon: MessageSquare,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10',
    border: 'border-amber-500/20',
  },
  mcp: {
    label: 'MCP',
    icon: Terminal,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
  },
};

// ---------------------------------------------------------------------------
// SourceBadge
// ---------------------------------------------------------------------------

function SourceBadge({ source }: { source?: string }) {
  const cfg = source ? SOURCE_CONFIG[source] : null;
  if (!cfg) return null;
  const Icon = cfg.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-medium rounded-full px-1.5 py-0.5 border',
        cfg.bg,
        cfg.border,
        cfg.color,
      )}
    >
      <Icon className="size-2.5" />
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// DiffView
// ---------------------------------------------------------------------------

function DiffView({ oldContent, newContent }: { oldContent: string; newContent: string }) {
  const lines = diffLines(oldContent, newContent);

  if (lines.every((l) => l.type === 'same')) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground/30 italic">
        No differences
      </div>
    );
  }

  let oldLineNum = 0;
  let newLineNum = 0;

  return (
    <div className="font-mono text-xs leading-5 overflow-x-auto">
      {lines.map((line, i) => {
        if (line.type === 'remove') oldLineNum++;
        else if (line.type === 'add') newLineNum++;
        else {
          oldLineNum++;
          newLineNum++;
        }

        return (
          <div
            key={i}
            className={cn(
              'flex min-w-0',
              line.type === 'add' && 'bg-emerald-500/[0.08]',
              line.type === 'remove' && 'bg-red-500/[0.08]',
            )}
          >
            <span className="w-8 shrink-0 text-right pr-1 select-none text-muted-foreground/20 border-r border-white/[0.04]">
              {line.type !== 'add' ? oldLineNum : ''}
            </span>
            <span className="w-8 shrink-0 text-right pr-1 select-none text-muted-foreground/20 border-r border-white/[0.04]">
              {line.type !== 'remove' ? newLineNum : ''}
            </span>
            <span
              className={cn(
                'w-4 shrink-0 text-center select-none',
                line.type === 'add' && 'text-emerald-400/60',
                line.type === 'remove' && 'text-red-400/60',
                line.type === 'same' && 'text-muted-foreground/15',
              )}
            >
              {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
            </span>
            <span
              className={cn(
                'flex-1 min-w-0 whitespace-pre-wrap break-all px-1',
                line.type === 'add' && 'text-emerald-300/80',
                line.type === 'remove' && 'text-red-300/80',
                line.type === 'same' && 'text-foreground/50',
              )}
            >
              {line.text || '\u00A0'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlanVersionPanel
// ---------------------------------------------------------------------------

interface PlanVersionPanelProps {
  planId: string;
  currentContent: string;
  onClose: () => void;
  onRestore: (content: string) => void;
}

export function PlanVersionPanel({
  planId,
  currentContent,
  onClose,
  onRestore,
}: PlanVersionPanelProps) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState<VersionDetail | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(false);
  const [viewMode, setViewMode] = useState<'content' | 'diff'>('diff');
  const [restoring, setRestoring] = useState(false);

  // Fetch version list
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<ApiResponse<VersionSummary[]>>(`/api/plans/${planId}/versions`)
      .then((res) => {
        if (!cancelled) setVersions(res.data);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [planId]);

  // Fetch a specific version's full content
  const selectVersion = useCallback(
    async (version: number) => {
      if (selectedVersion?.version === version) {
        setSelectedVersion(null);
        return;
      }
      setLoadingVersion(true);
      try {
        const res = await apiFetch<ApiResponse<VersionDetail>>(
          `/api/plans/${planId}/versions/${version}`,
        );
        setSelectedVersion(res.data);
      } catch {
        // ignore
      } finally {
        setLoadingVersion(false);
      }
    },
    [planId, selectedVersion?.version],
  );

  // Restore a version
  const handleRestore = useCallback(async () => {
    if (!selectedVersion) return;
    setRestoring(true);
    try {
      await apiFetch<ApiResponse<unknown>>(`/api/plans/${planId}/versions`, {
        method: 'POST',
        body: JSON.stringify({
          content: selectedVersion.content,
          metadata: { source: 'manual_edit' },
        }),
      });
      onRestore(selectedVersion.content);
      setSelectedVersion(null);
      // Refresh versions list
      const res = await apiFetch<ApiResponse<VersionSummary[]>>(`/api/plans/${planId}/versions`);
      setVersions(res.data);
    } catch {
      // ignore
    } finally {
      setRestoring(false);
    }
  }, [planId, selectedVersion, onRestore]);

  const latestVersion = versions[0]?.version;

  return (
    <div className="flex flex-col h-full w-full bg-[oklch(0.085_0.005_240)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06] shrink-0">
        <Clock className="size-3.5 text-muted-foreground/40" />
        <span className="text-xs font-medium text-foreground/70 flex-1">Version History</span>
        <span className="text-[10px] text-muted-foreground/30">
          {versions.length} version{versions.length !== 1 ? 's' : ''}
        </span>
        <button
          onClick={onClose}
          className="size-6 flex items-center justify-center rounded-md text-muted-foreground/30 hover:text-muted-foreground/60 hover:bg-white/[0.05] transition-colors"
          aria-label="Close version history"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Version detail view */}
      {selectedVersion && (
        <div className="border-b border-white/[0.06] shrink-0">
          {/* Detail header */}
          <div className="flex items-center gap-2 px-3 py-2 bg-white/[0.02]">
            <span className="text-xs font-medium text-foreground/70">
              v{selectedVersion.version}
            </span>
            <span className="text-[10px] text-muted-foreground/30 flex-1 truncate">
              {selectedVersion.title}
            </span>

            {/* View toggle */}
            <div className="flex items-center h-6 rounded-md border border-white/[0.07] bg-white/[0.02] overflow-hidden divide-x divide-white/[0.05]">
              <button
                onClick={() => setViewMode('diff')}
                title="Diff view"
                className={cn(
                  'h-full px-1.5 flex items-center transition-colors',
                  viewMode === 'diff'
                    ? 'bg-white/[0.08] text-foreground/70'
                    : 'text-muted-foreground/30 hover:text-muted-foreground/60',
                )}
              >
                <GitCompareArrows className="size-3" />
              </button>
              <button
                onClick={() => setViewMode('content')}
                title="Plain view"
                className={cn(
                  'h-full px-1.5 flex items-center transition-colors',
                  viewMode === 'content'
                    ? 'bg-white/[0.08] text-foreground/70'
                    : 'text-muted-foreground/30 hover:text-muted-foreground/60',
                )}
              >
                <FileText className="size-3" />
              </button>
            </div>

            {/* Restore button — only for non-latest versions */}
            {selectedVersion.version !== latestVersion && (
              <Button
                variant="ghost"
                size="sm"
                disabled={restoring}
                onClick={handleRestore}
                className="h-6 px-2 text-[11px] gap-1 text-amber-400/70 hover:text-amber-400 hover:bg-amber-500/10"
              >
                {restoring ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RotateCcw className="size-3" />
                )}
                Restore
              </Button>
            )}
          </div>

          {/* Content / Diff */}
          <div className="max-h-[50vh] overflow-y-auto border-t border-white/[0.04]">
            {viewMode === 'diff' ? (
              <DiffView oldContent={selectedVersion.content} newContent={currentContent} />
            ) : (
              <pre className="font-mono text-xs text-foreground/60 p-3 whitespace-pre-wrap break-words leading-5">
                {selectedVersion.content}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Version list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-4 animate-spin text-muted-foreground/30" />
          </div>
        ) : versions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2">
            <Clock className="size-5 text-muted-foreground/20" />
            <p className="text-xs text-muted-foreground/30">No versions yet</p>
          </div>
        ) : (
          <div className="py-1">
            {versions.map((v) => {
              const isLatest = v.version === latestVersion;
              const isSelected = selectedVersion?.version === v.version;

              return (
                <button
                  key={v.id}
                  onClick={() => selectVersion(v.version)}
                  disabled={loadingVersion}
                  className={cn(
                    'w-full text-left px-3 py-2 flex flex-col gap-1 transition-colors border-l-2',
                    isSelected
                      ? 'bg-white/[0.06] border-l-primary/50'
                      : 'border-l-transparent hover:bg-white/[0.03]',
                  )}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[11px] font-mono font-medium text-foreground/60 shrink-0">
                      v{v.version}
                    </span>
                    <span className="text-xs text-foreground/50 truncate flex-1">{v.title}</span>
                    {isLatest && (
                      <span className="text-[9px] font-medium text-emerald-400/70 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-1.5 py-0 shrink-0">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground/25" suppressHydrationWarning>
                      {formatDistanceToNow(new Date(v.createdAt), { addSuffix: true })}
                    </span>
                    <SourceBadge source={v.metadata?.source} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
