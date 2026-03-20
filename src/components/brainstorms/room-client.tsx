'use client';

import { useEffect, useSyncExternalStore, useState, useCallback } from 'react';
import { Users } from 'lucide-react';
import { RoomView } from './room-view';
import { ParticipantSidebar } from './participant-sidebar';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import { useBrainstormStream } from '@/hooks/use-brainstorm-stream';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { BrainstormWithDetails } from '@/lib/services/brainstorm-service';

// ============================================================================
// Client-only guard (prevents SSR mismatch for Zustand store)
// ============================================================================

const emptySubscribe = () => () => {};

function useIsClient() {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}

// ============================================================================
// Mobile sidebar trigger — shown in the room page header on small screens
// ============================================================================

function MobileSidebarTrigger({ onClick }: { onClick: () => void }) {
  const participantCount = useBrainstormStore((s) => s.participants.size);

  return (
    <button
      type="button"
      onClick={onClick}
      className="md:hidden flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-lg text-muted-foreground/60 hover:text-foreground/80 hover:bg-white/[0.06] transition-colors text-xs border border-white/[0.06]"
      aria-label="Open participants panel"
    >
      <Users className="size-3.5" />
      <span className="font-mono text-[11px]">{participantCount}</span>
    </button>
  );
}

// ============================================================================
// Inner client component (only mounts on the client)
// ============================================================================

function RoomClientInner({ room }: { room: BrainstormWithDetails }) {
  const setRoom = useBrainstormStore((s) => s.setRoom);
  const reset = useBrainstormStore((s) => s.reset);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const openMobileSidebar = useCallback(() => setMobileSidebarOpen(true), []);

  // Initialize store from server-fetched data
  useEffect(() => {
    setRoom(room);
    return () => {
      reset();
    };
  }, [room.id, setRoom, reset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to SSE stream
  const { isInitialCatchupPending } = useBrainstormStream(room.id);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Main conversation area */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 relative">
        <RoomView
          roomId={room.id}
          onOpenMobileSidebar={openMobileSidebar}
          isInitialCatchupPending={isInitialCatchupPending}
        />
      </div>

      {/* Sidebar — hidden on mobile (accessible via Sheet), visible on desktop */}
      <div className="hidden md:flex">
        <ParticipantSidebar roomId={room.id} />
      </div>

      {/* Mobile sidebar Sheet — ParticipantSidebar renders its own room header */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent
          side="right"
          className="w-[min(90vw,320px)] p-0 flex flex-col gap-0 bg-[oklch(0.085_0_0)]"
        >
          {/* Hidden title required by Sheet for a11y */}
          <SheetHeader className="sr-only">
            <SheetTitle>Room Details</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
            <ParticipantSidebar roomId={room.id} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ============================================================================
// Public export — wraps in client-only guard
// ============================================================================

export function RoomClient({ room }: { room: BrainstormWithDetails }) {
  const isClient = useIsClient();
  if (!isClient) return null;
  return <RoomClientInner key={room.id} room={room} />;
}

// Re-export trigger so the room page header can use it
export { MobileSidebarTrigger };
