'use client';

import { Maximize2, X } from 'lucide-react';
import type { SessionStatus } from '@/lib/realtime/events';
import { AttentionBadge } from './attention-badge';

// ---------------------------------------------------------------------------
// Status dot — colored circle matching session status
// ---------------------------------------------------------------------------

const STATUS_DOT: Record<string, { color: string; pulse: boolean; label: string }> = {
  active: { color: 'bg-sky-400', pulse: true, label: 'Active' },
  awaiting_input: { color: 'bg-emerald-400', pulse: true, label: 'Your turn' },
  idle: { color: 'bg-zinc-500', pulse: false, label: 'Paused' },
  ended: { color: 'bg-zinc-700', pulse: false, label: 'Ended' },
};

function StatusDot({ status }: { status: SessionStatus | null }) {
  if (!status) {
    return <span className="inline-block size-1.5 rounded-full bg-zinc-600" title="Connecting…" />;
  }
  const cfg = STATUS_DOT[status] ?? { color: 'bg-zinc-500', pulse: false, label: status };
  return (
    <span
      className={`inline-block size-1.5 rounded-full ${cfg.color} ${cfg.pulse ? 'animate-pulse' : ''}`}
      title={cfg.label}
    />
  );
}

// ---------------------------------------------------------------------------
// WorkspacePanelHeader
// ---------------------------------------------------------------------------

interface WorkspacePanelHeaderProps {
  sessionId: string;
  sessionTitle?: string | null;
  status: SessionStatus | null;
  needsAttention: boolean;
  onExpand: () => void;
  onRemove: () => void;
}

export function WorkspacePanelHeader({
  sessionId,
  sessionTitle,
  status,
  needsAttention,
  onExpand,
  onRemove,
}: WorkspacePanelHeaderProps) {
  const displayTitle = sessionTitle || `Session ${sessionId.slice(0, 8)}`;

  return (
    <div className="panel-drag-handle flex items-center gap-2 px-2.5 py-1.5 shrink-0 border-b border-white/[0.05] bg-[oklch(0.095_0.005_240)] cursor-grab active:cursor-grabbing select-none">
      {/* Status dot */}
      <StatusDot status={status} />

      {/* Session title */}
      <span
        className="flex-1 min-w-0 text-xs font-mono text-foreground/70 truncate"
        title={displayTitle}
      >
        {displayTitle}
      </span>

      {/* Attention badge */}
      {needsAttention && <AttentionBadge show={needsAttention} />}

      {/* Expand button */}
      <button
        type="button"
        onClick={onExpand}
        className="shrink-0 flex items-center justify-center h-5 w-5 rounded text-muted-foreground/35 hover:text-foreground/60 hover:bg-white/[0.06] transition-colors"
        aria-label="Expand panel"
      >
        <Maximize2 className="size-3" />
      </button>

      {/* Close button */}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 flex items-center justify-center h-5 w-5 rounded text-muted-foreground/35 hover:text-red-400/70 hover:bg-red-500/[0.08] transition-colors"
        aria-label="Remove panel"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
