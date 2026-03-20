'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainstormEvent, BrainstormRoomStatus } from '@/lib/realtime/event-types';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import { useEventSource } from './use-event-source';

const INITIAL_HISTORY_LOADER_MS = 1500;

/**
 * Subscribes to the SSE event stream for a brainstorm room and feeds events
 * into the Zustand store. Handles reconnection with exponential backoff and
 * last-event-id tracking for catch-up on reconnect.
 */
export function shouldCloseBrainstormStream(event: BrainstormEvent): boolean {
  return event.type === 'room:state' && event.status === 'ended' && event.id > 0;
}

export function shouldKeepBrainstormHistoryLoader(params: {
  status: BrainstormRoomStatus;
  messageCount: number;
  streamingCount: number;
}): boolean {
  return params.status !== 'waiting' && params.messageCount === 0 && params.streamingCount === 0;
}

export function useBrainstormStream(roomId: string | null): {
  isInitialCatchupPending: boolean;
} {
  const handleEvent = useBrainstormStore((s) => s.handleEvent);
  const status = useBrainstormStore((s) => s.status);
  const messageCount = useBrainstormStore((s) => s.messages.length);
  const streamingCount = useBrainstormStore((s) => s.streamingText.size);
  const [isInitialCatchupPending, setIsInitialCatchupPending] = useState(() => Boolean(roomId));
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimeout = useCallback(() => {
    if (pendingTimeoutRef.current) {
      clearTimeout(pendingTimeoutRef.current);
      pendingTimeoutRef.current = null;
    }
  }, []);

  const stopInitialCatchup = useCallback(() => {
    clearPendingTimeout();
    setIsInitialCatchupPending(false);
  }, [clearPendingTimeout]);

  const startInitialCatchup = useCallback(() => {
    clearPendingTimeout();
    setIsInitialCatchupPending(true);
    pendingTimeoutRef.current = setTimeout(() => {
      setIsInitialCatchupPending(false);
      pendingTimeoutRef.current = null;
    }, INITIAL_HISTORY_LOADER_MS);
  }, [clearPendingTimeout]);

  const url = roomId ? `/api/brainstorms/${roomId}/events` : null;

  const { markDone } = useEventSource({
    url,
    onOpen: () => {
      if (shouldKeepBrainstormHistoryLoader({ status, messageCount, streamingCount })) {
        startInitialCatchup();
        return;
      }

      stopInitialCatchup();
    },
    onMessage: (data: unknown) => {
      const parsed = data as BrainstormEvent;
      handleEvent(parsed);

      if (parsed.id > 0 || parsed.type !== 'room:state') {
        stopInitialCatchup();
      }

      // Worker SSE emits a synthetic room:state(id=0) before replay catchup.
      // Only close once we receive a persisted/live terminal event.
      if (shouldCloseBrainstormStream(parsed)) {
        stopInitialCatchup();
        markDone();
      }
    },
  });

  useEffect(() => {
    return () => {
      clearPendingTimeout();
    };
  }, [clearPendingTimeout]);

  return {
    isInitialCatchupPending:
      isInitialCatchupPending &&
      shouldKeepBrainstormHistoryLoader({ status, messageCount, streamingCount }),
  };
}
