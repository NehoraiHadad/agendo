'use client';

import type { BrainstormEvent } from '@/lib/realtime/event-types';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import { useEventSource } from './use-event-source';

/**
 * Subscribes to the SSE event stream for a brainstorm room and feeds events
 * into the Zustand store. Handles reconnection with exponential backoff and
 * last-event-id tracking for catch-up on reconnect.
 */
export function shouldCloseBrainstormStream(event: BrainstormEvent): boolean {
  return event.type === 'room:state' && event.status === 'ended' && event.id > 0;
}

export function useBrainstormStream(roomId: string | null): void {
  const handleEvent = useBrainstormStore((s) => s.handleEvent);

  const url = roomId ? `/api/brainstorms/${roomId}/events` : null;

  const { markDone } = useEventSource({
    url,
    onMessage: (data: unknown) => {
      const parsed = data as BrainstormEvent;
      handleEvent(parsed);

      // Worker SSE emits a synthetic room:state(id=0) before replay catchup.
      // Only close once we receive a persisted/live terminal event.
      if (shouldCloseBrainstormStream(parsed)) {
        markDone();
      }
    },
  });
}
