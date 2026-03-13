'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Plus, Lightbulb, Users, Waves, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CreateBrainstormDialog } from './create-dialog';
import type { BrainstormRoom, BrainstormStatus } from '@/lib/types';

// ============================================================================
// Helpers
// ============================================================================

interface StatusConfig {
  label: string;
  className: string;
  dotClassName: string;
  animated: boolean;
}

const STATUS_CONFIG: Record<BrainstormStatus, StatusConfig> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    dotClassName: 'bg-emerald-400',
    animated: true,
  },
  ended: {
    label: 'Ended',
    className: 'bg-zinc-500/10 text-zinc-500 border-zinc-600/20',
    dotClassName: 'bg-zinc-500',
    animated: false,
  },
  synthesizing: {
    label: 'Synthesizing',
    className: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    dotClassName: 'bg-violet-400',
    animated: true,
  },
  waiting: {
    label: 'Waiting',
    className: 'bg-zinc-500/10 text-zinc-400 border-zinc-600/15',
    dotClassName: 'bg-zinc-500',
    animated: false,
  },
  paused: {
    label: 'Paused',
    className: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    dotClassName: 'bg-amber-400',
    animated: false,
  },
};

function StatusBadge({ status }: { status: BrainstormStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded-full border ${config.className}`}
    >
      <span
        className={`size-1.5 rounded-full shrink-0 ${config.dotClassName} ${config.animated ? 'animate-pulse' : ''}`}
      />
      {config.label}
    </span>
  );
}

function formatRelative(date: Date | string): string {
  try {
    return formatDistanceToNow(new Date(date), { addSuffix: true });
  } catch {
    return '';
  }
}

// ============================================================================
// Room card
// ============================================================================

interface RoomCardProps {
  room: BrainstormRoom;
}

function RoomCard({ room }: RoomCardProps) {
  const isActive = room.status === 'active' || room.status === 'synthesizing';

  return (
    <Link
      href={`/brainstorms/${room.id}`}
      className="group flex items-start gap-4 px-4 py-4 rounded-xl border border-white/[0.06] bg-white/[0.01] hover:bg-white/[0.03] hover:border-white/[0.10] transition-all duration-150"
    >
      {/* Icon */}
      <div
        className={`shrink-0 flex items-center justify-center size-9 rounded-xl transition-colors ${
          isActive
            ? 'bg-emerald-500/[0.12] text-emerald-400/70 group-hover:text-emerald-400'
            : 'bg-white/[0.04] text-muted-foreground/40 group-hover:text-muted-foreground/70'
        }`}
      >
        <Lightbulb className="size-4" />
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground/90 truncate leading-snug">
              {room.title}
            </p>
            {room.topic && (
              <p className="text-xs text-muted-foreground/45 line-clamp-1 mt-0.5 leading-relaxed">
                {room.topic}
              </p>
            )}
          </div>
          <StatusBadge status={room.status} />
        </div>

        {/* Footer metadata */}
        <div className="flex items-center gap-3 mt-2.5">
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground/35">
            <Users className="size-3" />
            agents
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground/35">
            <Waves className="size-3" />
            Wave {room.currentWave ?? 0}/{room.maxWaves}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground/25 tabular-nums">
            {formatRelative(room.createdAt)}
          </span>
        </div>
      </div>

      {/* Arrow */}
      <ArrowRight className="size-3.5 text-muted-foreground/20 group-hover:text-muted-foreground/50 shrink-0 mt-1 transition-colors" />
    </Link>
  );
}

// ============================================================================
// Empty state
// ============================================================================

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] py-20 text-center px-8">
      <div className="flex items-center justify-center size-14 rounded-2xl bg-white/[0.04] border border-white/[0.06]">
        <Lightbulb className="size-6 text-muted-foreground/30" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground/60">No brainstorm rooms yet</p>
        <p className="text-xs text-muted-foreground/35 max-w-xs mx-auto leading-relaxed">
          Create a room to start a structured multi-agent discussion and explore ideas
          collaboratively.
        </p>
      </div>
      <Button size="sm" className="gap-1.5 mt-1" onClick={onNew}>
        <Plus className="size-3.5" />
        New Brainstorm
      </Button>
    </div>
  );
}

// ============================================================================
// Sections: active vs ended
// ============================================================================

function SectionLabel({ children, count }: { children: React.ReactNode; count: number }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="text-[10px] font-semibold text-muted-foreground/30 uppercase tracking-widest">
        {children}
      </span>
      <span className="text-[10px] text-muted-foreground/20 font-mono">{count}</span>
    </div>
  );
}

// ============================================================================
// Main component
// ============================================================================

interface BrainstormListProps {
  initialRooms: BrainstormRoom[];
}

export function BrainstormList({ initialRooms }: BrainstormListProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  const activeRooms = initialRooms.filter((r) => r.status !== 'ended');
  const endedRooms = initialRooms.filter((r) => r.status === 'ended');

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Brainstorms</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Multi-agent discussion rooms</p>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setDialogOpen(true)}>
          <Plus className="size-3.5" />
          New Brainstorm
        </Button>
      </div>

      {/* List */}
      {initialRooms.length === 0 ? (
        <EmptyState onNew={() => setDialogOpen(true)} />
      ) : (
        <div className="space-y-6">
          {activeRooms.length > 0 && (
            <div>
              <SectionLabel count={activeRooms.length}>Active</SectionLabel>
              <div className="flex flex-col gap-2">
                {activeRooms.map((room) => (
                  <RoomCard key={room.id} room={room} />
                ))}
              </div>
            </div>
          )}

          {endedRooms.length > 0 && (
            <div>
              <SectionLabel count={endedRooms.length}>Ended</SectionLabel>
              <div className="flex flex-col gap-2 opacity-70">
                {endedRooms.map((room) => (
                  <RoomCard key={room.id} room={room} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dialog */}
      <CreateBrainstormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
