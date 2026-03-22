'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrainstormEvent, BrainstormRoomStatus } from '@/lib/realtime/event-types';
import { createRAFBatcher } from '@/lib/utils/raf-batcher';
import { useBrainstormStore } from '@/stores/brainstorm-store';
import { useEventSource } from './use-event-source';

const INITIAL_HISTORY_LOADER_MS = 1500;

/**
 * Delay before closing the SSE stream after receiving a `room:state ended` event.
 * This prevents premature close during log replay: when a room has been extended
 * after ending, the log contains historical `room:state ended` events followed by
 * events from subsequent orchestrator lifecycles. The debounce ensures we only close
 * if no further events arrive (i.e., the room is truly finished).
 */
const STREAM_CLOSE_DEBOUNCE_MS = 300;

/**
 * Subscribes to the SSE event stream for a brainstorm room and feeds events
 * into the Zustand store. Handles reconnection with exponential backoff and
 * last-event-id tracking for catch-up on reconnect.
 *
 * Performance: incoming SSE events are coalesced via requestAnimationFrame
 * (shared `createRAFBatcher` utility) so that rapid catchup replay results
 * in a single batch store update per animation frame instead of one
 * re-render per event.
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

  // --- rAF batching via shared utility ---
  // Events are queued and flushed once per animation frame. During rapid SSE
  // catchup, this coalesces hundreds of events into a single handleEventBatch()
  // call (one React re-render). During live operation, events typically arrive
  // one at a time so each frame flushes a batch of 1.
  const batcherRef = useRef(
    createRAFBatcher<BrainstormEvent>((batch) => {
      if (batch.length === 1) {
        handleEvent(batch[0]);
      } else {
        handleEventBatch(batch);
      }
    }),
  );
  /** Debounced stream close timer — prevents premature close during log replay */
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep batcher's flush callback in sync with latest store methods
  useEffect(() => {
    batcherRef.current = createRAFBatcher<BrainstormEvent>((batch) => {
      if (batch.length === 1) {
        handleEvent(batch[0]);
      } else {
        handleEventBatch(batch);
      }
    });
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

      // Cancel any pending debounced close — more events arrived, so the
      // earlier `room:state ended` was historical (room was extended/steered).
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }

      // Queue the event for the next animation frame (always, even for ended)
      batcherRef.current.push(parsed);

      if (shouldCloseBrainstormStream(parsed)) {
        // Don't close immediately — during log replay, a historical
        // `room:state ended` event may be followed by events from a
        // subsequent orchestrator lifecycle (room was extended/steered).
        // Debounce: close only if no more events arrive within the window.
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null;
          stopInitialCatchup();
          // Flush any remaining events before closing
          batcherRef.current.flush();
          markDone();
        }, STREAM_CLOSE_DEBOUNCE_MS);
      }
    },
  });

  useEffect(() => {
    return () => {
      clearPendingTimeout();
      // Cancel any pending debounced close
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      // Flush remaining events synchronously so state is consistent
      batcherRef.current.flush();
    };
  }, [clearPendingTimeout]);

  return {
    isInitialCatchupPending:
      isInitialCatchupPending &&
      shouldKeepBrainstormHistoryLoader({ status, messageCount, streamingCount }),
  };
}
