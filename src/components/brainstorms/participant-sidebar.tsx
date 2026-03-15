'use client';

import { useState, useCallback } from 'react';
import {
  Loader2,
  Check,
  Clock,
  X,
  UserPlus,
  Square,
  Sparkles,
  Waves,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  getAgentColor,
  getInitials,
  BRAINSTORM_STATUS_CONFIG,
} from '@/lib/utils/brainstorm-colors';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import type { ParticipantState } from '@/stores/brainstorm-store';

// ============================================================================
// Status indicators per participant
// ============================================================================

interface StatusIndicatorProps {
  status: ParticipantState['status'];
}

function StatusIndicator({ status }: StatusIndicatorProps) {
  switch (status) {
    case 'thinking':
      return (
        <Loader2 className="size-3 text-blue-400 animate-spin shrink-0" aria-label="Thinking" />
      );
    case 'done':
      return <Check className="size-3 text-emerald-400 shrink-0" aria-label="Done" />;
    case 'passed':
      return <Check className="size-3 text-zinc-600 shrink-0" aria-label="Passed" />;
    case 'timeout':
      return <Clock className="size-3 text-amber-400 shrink-0" aria-label="Timed out" />;
    case 'left':
      return <X className="size-3 text-red-400 shrink-0" aria-label="Left" />;
    case 'active':
      return (
        <span
          className="block size-2 rounded-full bg-blue-400 animate-pulse shrink-0"
          aria-label="Active"
        />
      );
    default:
      return (
        <span className="block size-2 rounded-full bg-zinc-700 shrink-0" aria-label="Pending" />
      );
  }
}

function StatusLabel({ status }: { status: ParticipantState['status'] }) {
  const labels: Record<ParticipantState['status'], { text: string; className: string }> = {
    thinking: { text: 'thinking', className: 'text-blue-400' },
    done: { text: 'done', className: 'text-emerald-400' },
    passed: { text: 'passed', className: 'text-muted-foreground/35' },
    timeout: { text: 'timeout', className: 'text-amber-400' },
    left: { text: 'left', className: 'text-red-400' },
    active: { text: 'active', className: 'text-blue-400' },
    pending: { text: 'pending', className: 'text-muted-foreground/35' },
  };
  const { text, className } = labels[status];
  return <span className={`text-[10px] font-medium ${className}`}>{text}</span>;
}

// ============================================================================
// Room status badge (uses shared config — single source of truth)
// ============================================================================

function RoomStatusBadge({ status }: { status: string }) {
  const c = BRAINSTORM_STATUS_CONFIG[status] ?? BRAINSTORM_STATUS_CONFIG.waiting;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full border ${c.className}`}
    >
      <span
        className={`size-1.5 rounded-full shrink-0 ${c.dotClassName} ${c.animated ? 'animate-pulse' : ''}`}
      />
      {c.label}
    </span>
  );
}

// ============================================================================
// Agent selector for adding participants
// ============================================================================

interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

function AddParticipantRow({
  roomId,
  existingAgentIds,
}: {
  roomId: string;
  existingAgentIds: Set<string>;
}) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const handleOpen = useCallback(async () => {
    if (agents.length > 0) {
      setIsOpen(true);
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error('Failed to fetch agents');
      const body = (await res.json()) as { data: AgentOption[] };
      setAgents((body.data ?? []).filter((a) => !existingAgentIds.has(a.id)));
      setIsOpen(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load agents');
    } finally {
      setIsLoading(false);
    }
  }, [agents.length, existingAgentIds]);

  const handleAdd = useCallback(async () => {
    if (!selectedId || isAdding) return;
    setIsAdding(true);
    try {
      const res = await fetch(`/api/brainstorms/${roomId}/participants`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: selectedId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast.success('Participant added');
      setIsOpen(false);
      setSelectedId('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add participant');
    } finally {
      setIsAdding(false);
    }
  }, [selectedId, isAdding, roomId]);

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void handleOpen()}
        disabled={isLoading}
        className="w-full h-8 text-xs border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05] text-muted-foreground/60 hover:text-foreground/80 gap-1.5"
      >
        {isLoading ? <Loader2 className="size-3 animate-spin" /> : <UserPlus className="size-3" />}
        Add Participant
      </Button>
    );
  }

  const availableAgents = agents.filter((a) => !existingAgentIds.has(a.id));

  return (
    <div className="flex gap-1.5">
      <Select value={selectedId} onValueChange={setSelectedId}>
        <SelectTrigger className="flex-1 h-8 text-xs border-white/[0.08] bg-white/[0.02]">
          <SelectValue placeholder="Select agent..." />
        </SelectTrigger>
        <SelectContent>
          {availableAgents.length === 0 ? (
            <SelectItem value="__none" disabled>
              No agents available
            </SelectItem>
          ) : (
            availableAgents.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        onClick={() => void handleAdd()}
        disabled={!selectedId || isAdding}
        className="h-8 px-2.5 shrink-0"
        aria-label="Confirm add participant"
      >
        {isAdding ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setIsOpen(false)}
        className="h-8 px-2 shrink-0 text-muted-foreground/50"
        aria-label="Cancel"
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

// ============================================================================
// Participant row
// ============================================================================

function ParticipantRow({ participant, index }: { participant: ParticipantState; index: number }) {
  const colors = getAgentColor(participant.agentSlug || '', index);
  const initials = getInitials(participant.agentName);

  return (
    <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-white/[0.02] transition-colors">
      {/* Avatar with color dot */}
      <div
        className={`shrink-0 size-7 rounded-full flex items-center justify-center text-[10px] font-bold border ${colors.border.replace('border-l-', 'border-')} bg-white/[0.03]`}
        aria-label={participant.agentName}
      >
        <span className={colors.dot}>{initials}</span>
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium text-foreground/80 truncate block">
          {participant.agentName}
        </span>
        {participant.model && (
          <span className="text-[10px] text-muted-foreground/30 font-mono block truncate">
            {participant.model.replace('claude-', 'cl-').replace('gemini-', 'ge-').slice(0, 18)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <StatusIndicator status={participant.status} />
        <StatusLabel status={participant.status} />
      </div>
    </div>
  );
}

// ============================================================================
// Main sidebar
// ============================================================================

interface ParticipantSidebarProps {
  roomId: string;
}

export function ParticipantSidebar({ roomId }: ParticipantSidebarProps) {
  // Individual selectors — avoids useSyncExternalStore infinite loop in Zustand 5.
  const title = useBrainstormStore((s) => s.title);
  const topic = useBrainstormStore((s) => s.topic);
  const status = useBrainstormStore((s) => s.status);
  const currentWave = useBrainstormStore((s) => s.currentWave);
  const maxWaves = useBrainstormStore((s) => s.maxWaves);
  const participants = useBrainstormStore((s) => s.participants);

  const router = useRouter();

  const [isEnding, setIsEnding] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isContinuing, setIsContinuing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const participantList = Array.from(participants.values());
  const existingAgentIds = new Set(participantList.map((p) => p.agentId));

  const handleEnd = useCallback(async () => {
    if (isEnding) return;
    setIsEnding(true);
    try {
      const res = await fetch(`/api/brainstorms/${roomId}/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      // Update local store immediately — SSE may not be connected for
      // waiting/paused rooms, so the room:state event might not arrive.
      useBrainstormStore.getState().handleEvent({
        id: 0,
        roomId,
        ts: Date.now(),
        type: 'room:state',
        status: 'ended',
      });
      toast.success('Brainstorm ended');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to end brainstorm');
    } finally {
      setIsEnding(false);
    }
  }, [isEnding, roomId]);

  const handleSynthesize = useCallback(async () => {
    if (isSynthesizing) return;
    setIsSynthesizing(true);
    try {
      const res = await fetch(`/api/brainstorms/${roomId}/end`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ synthesize: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast.success('Synthesis started');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start synthesis');
    } finally {
      setIsSynthesizing(false);
    }
  }, [isSynthesizing, roomId]);

  const handleContinue = useCallback(async () => {
    if (isContinuing) return;
    setIsContinuing(true);
    try {
      const res = await fetch(`/api/brainstorms/${roomId}/extend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ additionalWaves: 5 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast.success('Brainstorm continuing — 5 more rounds');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to continue brainstorm');
    } finally {
      setIsContinuing(false);
    }
  }, [isContinuing, roomId]);

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    if (isDeleting) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/brainstorms/${roomId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast.success('Brainstorm deleted');
      router.push('/brainstorms');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  }, [confirmDelete, isDeleting, roomId, router]);

  const canEnd = status === 'active' || status === 'paused';
  // Synthesis requires the orchestrator to still be running — only possible when paused.
  // An ended room has no orchestrator listening; the synthesis button would silently fail.
  const canSynthesize = status === 'paused';
  const canAddParticipant = status === 'waiting';
  const canContinue = status === 'ended';
  const canDelete = status === 'ended' || status === 'waiting';

  // Wave progress percentage
  const waveProgress = maxWaves > 0 ? Math.min((currentWave / maxWaves) * 100, 100) : 0;

  return (
    <div className="flex flex-col w-[272px] shrink-0 border-l border-white/[0.06] bg-[oklch(0.085_0_0)] overflow-hidden">
      {/* Room header */}
      <div className="px-4 pt-4 pb-3 shrink-0 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground/90 leading-snug flex-1 min-w-0 line-clamp-2">
            {title}
          </h2>
          <RoomStatusBadge status={status} />
        </div>
        {topic && (
          <p
            dir="auto"
            className="text-[11px] text-muted-foreground/45 leading-relaxed line-clamp-3"
          >
            {topic}
          </p>
        )}
      </div>

      {/* Wave progress */}
      {(status === 'active' || status === 'paused' || currentWave > 0) && (
        <div className="px-4 pb-3 shrink-0">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Waves className="size-3 text-muted-foreground/25 shrink-0" />
                <span className="text-[10px] text-muted-foreground/40 font-mono">
                  Wave {currentWave} / {maxWaves}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground/25 font-mono">
                {Math.round(waveProgress)}%
              </span>
            </div>
            <div className="h-1 bg-white/[0.05] rounded-full overflow-hidden">
              <div
                className="h-full bg-primary/50 rounded-full transition-all duration-700 ease-out"
                style={{ width: `${waveProgress}%` }}
                role="progressbar"
                aria-valuenow={currentWave}
                aria-valuemin={0}
                aria-valuemax={maxWaves}
              />
            </div>
          </div>
        </div>
      )}

      <Separator className="bg-white/[0.04] shrink-0" />

      {/* Participants header */}
      <div className="px-4 pt-3 pb-1.5 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold text-muted-foreground/30 uppercase tracking-widest">
            Participants
          </span>
          <Badge
            variant="outline"
            className="text-[9px] h-4 px-1.5 border-white/[0.08] text-muted-foreground/35 font-mono"
          >
            {participantList.length}
          </Badge>
        </div>
      </div>

      {/* Participant list */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
        <div className="px-2 pb-2">
          {participantList.length === 0 ? (
            <div className="px-2 py-8 text-center">
              <p className="text-xs text-muted-foreground/25">No participants yet</p>
              {canAddParticipant && (
                <p className="text-[10px] text-muted-foreground/20 mt-1">Add agents below</p>
              )}
            </div>
          ) : (
            <div className="space-y-0.5">
              {participantList.map((p, idx) => (
                <ParticipantRow key={p.agentId} participant={p} index={idx} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      {(canAddParticipant || canSynthesize || canEnd || canContinue || canDelete) && (
        <div className="shrink-0 border-t border-white/[0.04] p-3 space-y-2">
          {canAddParticipant && (
            <AddParticipantRow roomId={roomId} existingAgentIds={existingAgentIds} />
          )}

          {canSynthesize && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSynthesize()}
              disabled={isSynthesizing}
              className="w-full h-8 text-xs border-violet-500/20 bg-violet-500/[0.04] hover:bg-violet-500/[0.08] text-violet-400/80 hover:text-violet-300 hover:border-violet-500/30 gap-1.5 transition-colors"
            >
              {isSynthesizing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              Synthesize Discussion
            </Button>
          )}

          {canEnd && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleEnd()}
              disabled={isEnding}
              className="w-full h-8 text-xs border-red-500/15 bg-white/[0.01] hover:bg-red-500/[0.05] text-red-400/60 hover:text-red-300 hover:border-red-500/25 gap-1.5 transition-colors"
            >
              {isEnding ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Square className="size-3 fill-current" />
              )}
              End Brainstorm
            </Button>
          )}

          {canContinue && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleContinue()}
              disabled={isContinuing}
              className="w-full h-8 text-xs border-emerald-500/20 bg-emerald-500/[0.04] hover:bg-emerald-500/[0.08] text-emerald-400/80 hover:text-emerald-300 hover:border-emerald-500/30 gap-1.5 transition-colors"
            >
              {isContinuing ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RefreshCw className="size-3" />
              )}
              Continue (+5 rounds)
            </Button>
          )}

          {canDelete && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={isDeleting}
              className="w-full h-8 text-xs border-red-500/15 bg-white/[0.01] hover:bg-red-500/[0.05] text-red-400/60 hover:text-red-300 hover:border-red-500/25 gap-1.5 transition-colors"
            >
              {isDeleting ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
              {confirmDelete ? 'Confirm delete?' : 'Delete Room'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
