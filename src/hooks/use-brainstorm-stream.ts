'use client';

import { useEffect, useRef } from 'react';
import type { BrainstormEvent } from '@/lib/realtime/event-types';
import { useBrainstormStore } from '@/stores/brainstorm-store';

/**
 * Subscribes to the SSE event stream for a brainstorm room and feeds events
 * into the Zustand store. Handles reconnection with exponential backoff and
 * last-event-id tracking for catch-up on reconnect.
 */
export function useBrainstormStream(roomId: string | null): void {
  const handleEvent = useBrainstormStore((s) => s.handleEvent);
  const status = useBrainstormStore((s) => s.status);

  const retryDelayRef = useRef(1000);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef(0);
  const isDoneRef = useRef(false);

  useEffect(() => {
    if (!roomId) return;

    retryDelayRef.current = 1000;
    lastEventIdRef.current = 0;
    isDoneRef.current = false;

    function connect() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const lastId = lastEventIdRef.current;
      const url = `/api/brainstorms/${roomId}/live${lastId > 0 ? `?lastEventId=${lastId}` : ''}`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        retryDelayRef.current = 1000;
      };

      es.onmessage = (event) => {
        // Track last-event-id for reconnect
        if (event.lastEventId) {
          const id = parseInt(event.lastEventId, 10);
          if (!isNaN(id) && id > lastEventIdRef.current) {
            lastEventIdRef.current = id;
          }
        }

        try {
          const parsed = JSON.parse(event.data) as BrainstormEvent;
          handleEvent(parsed);

          // Stop reconnecting when room has ended
          if (parsed.type === 'room:state' && parsed.status === 'ended') {
            isDoneRef.current = true;
          }
        } catch {
          // Ignore malformed messages
        }
      };

      es.onerror = () => {
        es.close();

        // Don't reconnect if the room has ended
        if (isDoneRef.current) return;

        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, 30_000);
        setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [roomId, handleEvent]);

  // Stop reconnecting when status transitions to ended
  useEffect(() => {
    if (status === 'ended') {
      isDoneRef.current = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }
  }, [status]);
}
