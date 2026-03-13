'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { RoomView } from './room-view';
import { ParticipantSidebar } from './participant-sidebar';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import { useBrainstormStream } from '@/hooks/use-brainstorm-stream';
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
// Inner client component (only mounts on the client)
// ============================================================================

function RoomClientInner({ room }: { room: BrainstormWithDetails }) {
  const setRoom = useBrainstormStore((s) => s.setRoom);
  const reset = useBrainstormStore((s) => s.reset);

  // Initialize store from server-fetched data
  useEffect(() => {
    setRoom(room);
    return () => {
      reset();
    };
  }, [room.id, setRoom, reset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to SSE stream
  useBrainstormStream(room.id);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Main conversation area */}
      <div className="flex flex-col flex-1 min-h-0 min-w-0 relative">
        <RoomView roomId={room.id} />
      </div>

      {/* Sidebar — hidden on mobile (shown in Sheet), visible on desktop */}
      <div className="hidden md:flex">
        <ParticipantSidebar roomId={room.id} />
      </div>
    </div>
  );
}

// ============================================================================
// Public export — wraps in client-only guard
// ============================================================================

export function RoomClient({ room }: { room: BrainstormWithDetails }) {
  const isClient = useIsClient();
  if (!isClient) return null;
  return <RoomClientInner room={room} />;
}
