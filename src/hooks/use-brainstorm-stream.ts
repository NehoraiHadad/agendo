'use client';

import { useEffect } from 'react';
import type { BrainstormEvent } from '@/lib/realtime/event-types';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import { useEventSource } from './use-event-source';

/**
 * Subscribes to the SSE event stream for a brainstorm room and feeds events
 * into the Zustand store. Handles reconnection with exponential backoff and
 * last-event-id tracking for catch-up on reconnect.
 */
export function useBrainstormStream(roomId: string | null): void {
  const handleEvent = useBrainstormStore((s) => s.handleEvent);
  const status = useBrainstormStore((s) => s.status);

  const url = roomId ? `/api/brainstorms/${roomId}/events` : null;

  const { markDone } = useEventSource({
    url,
    onMessage: (data: unknown) => {
      const parsed = data as BrainstormEvent;
      handleEvent(parsed);

      // Stop reconnecting when room has ended
      if (parsed.type === 'room:state' && parsed.status === 'ended') {
        markDone();
      }
    },
  });

  // Stop reconnecting when status transitions to ended (external detection)
  useEffect(() => {
    if (status === 'ended') {
      markDone();
    }
  }, [status, markDone]);
}
