'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  Clock,
  Cpu,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Zap,
  FileText,
} from 'lucide-react';
import type { TaskNotification } from '@/lib/utils/task-notification-parser';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${min}m ${remSec}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Card Component
// ---------------------------------------------------------------------------

export function TaskNotificationCard({ notification }: { notification: TaskNotification }) {
  const [expanded, setExpanded] = useState(false);
  const isCompleted = notification.status === 'completed';
  const isFailed = notification.status === 'failed' || notification.status === 'error';

  // Accent colors based on status
  const accentColor = isFailed
    ? 'oklch(0.65 0.2 25)'
    : isCompleted
      ? 'oklch(0.7 0.17 155)'
      : 'oklch(0.7 0.15 60)';
  const accentBg = isFailed
    ? 'oklch(0.65 0.2 25 / 0.08)'
    : isCompleted
      ? 'oklch(0.7 0.17 155 / 0.06)'
      : 'oklch(0.7 0.15 60 / 0.06)';
  const accentBorder = isFailed
    ? 'oklch(0.65 0.2 25 / 0.2)'
    : isCompleted
      ? 'oklch(0.7 0.17 155 / 0.15)'
      : 'oklch(0.7 0.15 60 / 0.15)';

  const StatusIcon = isFailed ? XCircle : isCompleted ? CheckCircle2 : Clock;

  return (
    <div
      className="rounded-lg overflow-hidden text-xs my-1"
      style={{
        border: `1px solid ${accentBorder}`,
        background: accentBg,
      }}
    >
      {/* Header */}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:brightness-110"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        {/* Status icon */}
        <StatusIcon className="size-3.5 shrink-0" style={{ color: accentColor }} />

        {/* Agent badge */}
        <span
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest leading-4"
          style={{
            background: `color-mix(in oklch, ${accentColor} 15%, transparent)`,
            color: accentColor,
            border: `1px solid color-mix(in oklch, ${accentColor} 25%, transparent)`,
          }}
        >
          <Cpu className="size-2.5" />
          agent
        </span>

        {/* Summary text */}
        <span className="flex-1 min-w-0 truncate text-[11px] font-medium text-foreground/80">
          {notification.summary}
        </span>

        {/* Usage pills */}
        {notification.usage && (
          <span className="hidden sm:inline-flex items-center gap-2 text-[10px] text-muted-foreground/50 font-mono">
            {notification.usage.durationMs > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Clock className="size-2.5" />
                {formatDuration(notification.usage.durationMs)}
              </span>
            )}
            {notification.usage.toolUses > 0 && (
              <span className="inline-flex items-center gap-0.5">
                <Zap className="size-2.5" />
                {notification.usage.toolUses}
              </span>
            )}
            {notification.usage.totalTokens > 0 && (
              <span>{formatTokens(notification.usage.totalTokens)} tok</span>
            )}
          </span>
        )}

        {/* Expand chevron */}
        <span className="text-muted-foreground/30">
          {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2" style={{ borderTop: `1px solid ${accentBorder}` }}>
          {/* Result summary */}
          {notification.result && (
            <div className="mt-2">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground/50 font-medium uppercase tracking-wide mb-1">
                <FileText className="size-2.5" />
                Result
              </div>
              <div className="bg-black/30 rounded-md p-2.5 text-[11px] text-foreground/70 leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap font-mono">
                {notification.result}
              </div>
            </div>
          )}

          {/* Usage stats (mobile — always visible on expand) */}
          {notification.usage && (
            <div className="sm:hidden flex items-center gap-3 text-[10px] text-muted-foreground/50 font-mono mt-1">
              {notification.usage.durationMs > 0 && (
                <span className="inline-flex items-center gap-0.5">
                  <Clock className="size-2.5" />
                  {formatDuration(notification.usage.durationMs)}
                </span>
              )}
              {notification.usage.toolUses > 0 && (
                <span className="inline-flex items-center gap-0.5">
                  <Zap className="size-2.5" />
                  {notification.usage.toolUses} tools
                </span>
              )}
              {notification.usage.totalTokens > 0 && (
                <span>{formatTokens(notification.usage.totalTokens)} tokens</span>
              )}
            </div>
          )}

          {/* Worktree info */}
          {notification.worktree && (
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
              <GitBranch className="size-2.5" />
              <span className="font-mono">{notification.worktree.branch}</span>
            </div>
          )}

          {/* Task ID */}
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/30 font-mono">
            <span>task:{notification.taskId.slice(0, 10)}…</span>
          </div>
        </div>
      )}
    </div>
  );
}
