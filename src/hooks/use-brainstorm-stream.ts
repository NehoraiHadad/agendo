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
 *
 * Performance: incoming SSE events are coalesced via requestAnimationFrame
 * so that rapid catchup replay results in a single batch store update per
 * animation frame instead of one re-render per event.
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
  const handleEventBatch = useBrainstormStore((s) => s.handleEventBatch);
  const status = useBrainstormStore((s) => s.status);
  const messageCount = useBrainstormStore((s) => s.messages.length);
  const streamingCount = useBrainstormStore((s) => s.streamingText.size);
  const [isInitialCatchupPending, setIsInitialCatchupPending] = useState(() => Boolean(roomId));
  const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- rAF batching ---
  // Events are queued and flushed once per animation frame. During rapid SSE
  // catchup, this coalesces hundreds of events into a single handleEventBatch()
  // call (one React re-render). During live operation, events typically arrive
  // one at a time so each frame flushes a batch of 1.
  const batchRef = useRef<BrainstormEvent[]>([]);
  const rafRef = useRef<number>(0);

  const flushBatch = useCallback(() => {
    rafRef.current = 0;
    const batch = batchRef.current;
    if (batch.length === 0) return;
    batchRef.current = [];

    if (batch.length === 1) {
      handleEvent(batch[0]);
    } else {
      handleEventBatch(batch);
    }
  }, [handleEvent, handleEventBatch]);

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

      // Lightweight catchup / lifecycle checks run synchronously (no store mutation)
      if (parsed.id > 0 || parsed.type !== 'room:state') {
        stopInitialCatchup();
      }

      if (shouldCloseBrainstormStream(parsed)) {
        stopInitialCatchup();
        // Flush any pending batch immediately before closing
        if (batchRef.current.length > 0) {
          batchRef.current.push(parsed);
          if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = 0;
          }
          flushBatch();
        } else {
          handleEvent(parsed);
        }
        markDone();
        return;
      }

      // Queue the event for the next animation frame
      batchRef.current.push(parsed);
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(flushBatch);
      }
    },
  });

  useEffect(() => {
    return () => {
      clearPendingTimeout();
      // Flush any pending events on unmount
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      // Process remaining batch synchronously so state is consistent
      if (batchRef.current.length > 0) {
        const batch = batchRef.current;
        batchRef.current = [];
        if (batch.length === 1) {
          useBrainstormStore.getState().handleEvent(batch[0]);
        } else {
          useBrainstormStore.getState().handleEventBatch(batch);
        }
      }
    };
  }, [clearPendingTimeout]);

  return {
    isInitialCatchupPending:
      isInitialCatchupPending &&
      shouldKeepBrainstormHistoryLoader({ status, messageCount, streamingCount }),
  };
}
