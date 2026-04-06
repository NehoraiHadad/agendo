'use client';

import { useReducer, useEffect, useCallback, useRef, useState } from 'react';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';
import { appendWithWindow } from '@/lib/utils/event-window';
import { createScopedDedup } from '@/lib/utils/scoped-dedup';
import { createRAFBatcher, type RAFBatcher } from '@/lib/utils/raf-batcher';
import { createStreamReducer } from './create-stream-reducer';
import { useEventSource } from './use-event-source';

interface SessionStreamState {
  events: AgendoEvent[];
  sessionStatus: SessionStatus | null;
  /** Latest permission mode from session:mode-change events (real-time). */
  permissionMode: string | null;
  isConnected: boolean;
  error: string | null;
}

type CustomAction =
  | { type: 'APPEND_EVENT'; event: AgendoEvent }
  | { type: 'APPEND_BATCH'; events: AgendoEvent[] }
  | { type: 'PREPEND_HISTORY'; events: AgendoEvent[] }
  | { type: 'SET_STATUS'; status: SessionStatus };

const MAX_EVENTS = 10000;

const initialState: SessionStreamState = {
  events: [],
  sessionStatus: null,
  permissionMode: null,
  isConnected: false,
  error: null,
};

/**
 * Module-level O(1) dedup index — keyed by session ID so multiple hook
 * instances (session detail, plan panel, support chat) don't interfere.
 * Not stored in React state to avoid triggering re-renders on bookkeeping.
 */
const eventDedup = createScopedDedup<number>();

/**
 * Append a single pre-deduped event with windowing and mode tracking.
 * Caller is responsible for dedup checking before dispatching.
 */
function appendSingle(state: SessionStreamState, event: AgendoEvent): SessionStreamState {
  const { items: trimmed } = appendWithWindow(state.events, event, MAX_EVENTS);
  const newMode = event.type === 'session:mode-change' ? event.mode : state.permissionMode;
  return { ...state, events: trimmed, permissionMode: newMode };
}

const reducer = createStreamReducer<SessionStreamState, CustomAction>(
  initialState,
  (state, action) => {
    switch (action.type) {
      case 'APPEND_EVENT':
        return appendSingle(state, action.event);
      case 'APPEND_BATCH': {
        if (action.events.length === 0) return state;
        // Build final events array in one pass, apply window once at the end
        let events = state.events;
        let permissionMode = state.permissionMode;
        for (const event of action.events) {
          events = [...events, event];
          if (event.type === 'session:mode-change') {
            permissionMode = event.mode;
          }
        }
        if (events.length > MAX_EVENTS) {
          events = events.slice(events.length - MAX_EVENTS);
        }
        return { ...state, events, permissionMode };
      }
      case 'PREPEND_HISTORY': {
        if (action.events.length === 0) return state;
        // Prepend older events from REST history API before existing events.
        // No windowing needed — older events are loaded on-demand by user scroll.
        const events = [...action.events, ...state.events];
        return { ...state, events };
      }
      case 'SET_STATUS':
        return { ...state, sessionStatus: action.status };
      default:
        return undefined;
    }
  },
);

export interface UseSessionStreamReturn extends SessionStreamState {
  reset: () => void;
  /** Load older events from the REST history API. Returns true if there are more events to load. */
  loadOlderHistory: () => Promise<boolean>;
  /** Whether there are older events available to load via loadOlderHistory(). */
  hasOlderHistory: boolean;
  /** Whether older history is currently being fetched. */
  isLoadingOlderHistory: boolean;
}

/** Polling interval for status reconciliation fallback (30s). */
const STATUS_POLL_INTERVAL_MS = 30_000;

/** Number of events to fetch per "load more" page. */
const HISTORY_PAGE_SIZE = 300;

export function useSessionStream(sessionId: string | null): UseSessionStreamReturn {
  const [state, dispatch] = useReducer(reducer, initialState);
  const isDoneRef = useRef(false);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  const [isLoadingOlderHistory, setIsLoadingOlderHistory] = useState(false);

  // Dedup-aware push: checks O(1) dedup before queueing for dispatch.
  // Returns false if the event was a duplicate.
  const dedupPushRef = useRef<(event: AgendoEvent) => boolean>(() => false);
  const batcherRef = useRef<RAFBatcher<AgendoEvent>>(
    createRAFBatcher<AgendoEvent>((batch) => {
      if (batch.length === 1) {
        dispatch({ type: 'APPEND_EVENT', event: batch[0] });
      } else {
        dispatch({ type: 'APPEND_BATCH', events: batch });
      }
    }),
  );

  // Keep dedupPush in sync with current sessionId
  useEffect(() => {
    dedupPushRef.current = (event: AgendoEvent): boolean => {
      if (!sessionId) return false;
      if (!eventDedup.add(sessionId, event.id)) return false;
      batcherRef.current.push(event);
      return true;
    };
  }, [sessionId]);

  const reset = useCallback(() => {
    batcherRef.current.cancel();
    if (sessionId) {
      eventDedup.clear(sessionId);
    }
    dispatch({ type: 'RESET' });
    isDoneRef.current = false;
    setHasOlderHistory(false);
  }, [sessionId]);

  // SSE via the Next.js proxy route. The proxy uses node:http (no body
  // timeout) so the stream stays alive indefinitely with the worker's 15s
  // heartbeat. This works over any protocol (HTTP/HTTPS/Tailscale).
  const url = sessionId ? `/api/sessions/${sessionId}/events` : null;

  const { isConnected, error, markDone, setLastEventId } = useEventSource({
    url,
    onOpen: () => {
      dispatch({ type: 'SET_CONNECTED', connected: true });
    },
    onMessage: (data: unknown, rawEvent: MessageEvent) => {
      // Track last-event-id for reconnect.
      // Handle ID resets after session restarts: if the new ID drops
      // significantly below our tracked max, a restart happened and
      // we should reset to the new (lower) counter.
      if (rawEvent.lastEventId) {
        const id = parseInt(rawEvent.lastEventId, 10);
        if (!isNaN(id)) {
          setLastEventId(id);
        }
      }

      const parsed = data as AgendoEvent;

      if (parsed.type === 'session:state') {
        // Status events bypass the batcher — they're lightweight and
        // need to update UI immediately (e.g. "ended" stops polling).
        dispatch({ type: 'SET_STATUS', status: parsed.status });
        if (parsed.status === 'ended') {
          isDoneRef.current = true;
          markDone();
        }
      } else {
        // Detect server-side truncation marker to enable "load more" button.
        // The server sends this when it limits catchup events to MAX_CATCHUP_EVENTS.
        if (
          parsed.type === 'system:info' &&
          'message' in parsed &&
          typeof parsed.message === 'string' &&
          parsed.message.includes('scroll up to load more')
        ) {
          setHasOlderHistory(true);
        }

        // O(1) dedup + RAF-batched append
        dedupPushRef.current(parsed);
      }
    },
    onReconnect: () => {
      // Flush any pending batched events to ensure state is consistent.
      batcherRef.current.flush();
      // Incremental reconnect: keep existing events, lastEventId, and dedup.
      //
      // Previous behavior: RESET + resetLastEventId forced a full replay of
      // ALL events on every reconnect. With MAX_EVENTS cap, this caused
      // truncation — old messages lost when total events exceeded the window.
      //
      // New behavior: server sends only events AFTER our lastEventId. Since
      // those event IDs are > what we've seen, dedup correctly accepts them
      // without clearing. The session:state event (id=0) bypasses dedup
      // entirely, so it's always received on reconnect.
      //
      // Session restarts (event ID resets) are rare and handled by the
      // session:state event — if status changes unexpectedly, the UI can
      // trigger a full refresh via the reset() function.
    },
  });

  // Load older events via the REST history API (scroll-back pagination)
  const loadOlderHistory = useCallback(async (): Promise<boolean> => {
    if (!sessionId || isLoadingOlderHistory) return false;

    setIsLoadingOlderHistory(true);
    try {
      // Find the oldest event ID in our current buffer
      const oldestId = state.events.length > 0 ? state.events[0].id : undefined;
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
      if (oldestId != null) {
        params.set('beforeSeq', String(oldestId));
      }

      const res = await fetch(`/api/sessions/${sessionId}/history?${params.toString()}`);
      if (!res.ok) return false;

      const data = (await res.json()) as {
        events: AgendoEvent[];
        hasMore: boolean;
      };

      if (data.events.length > 0) {
        // Register all prepended events in the dedup index
        for (const ev of data.events) {
          eventDedup.add(sessionId, ev.id);
        }
        dispatch({ type: 'PREPEND_HISTORY', events: data.events });
      }

      setHasOlderHistory(data.hasMore);
      return data.hasMore;
    } catch {
      return false;
    } finally {
      setIsLoadingOlderHistory(false);
    }
  }, [sessionId, isLoadingOlderHistory, state.events]);

  // Sync connection state from useEventSource into the reducer-driven state
  useEffect(() => {
    dispatch({ type: 'SET_CONNECTED', connected: isConnected });
  }, [isConnected]);

  useEffect(() => {
    if (error) {
      dispatch({ type: 'SET_ERROR', error });
    }
  }, [error]);

  // Reset local state when sessionId changes
  useEffect(() => {
    return () => {
      if (sessionId) eventDedup.clear(sessionId);
    };
  }, [sessionId]);

  useEffect(() => {
    // Drop queued events from the previous session before resetting state.
    batcherRef.current.cancel();
    dispatch({ type: 'RESET' });
    isDoneRef.current = false;
    setHasOlderHistory(false);
  }, [sessionId]);

  useEffect(() => {
    const batcher = batcherRef.current;
    return () => {
      batcher.cancel();
    };
  }, []);

  // Polling fallback: periodically fetch the real session status from the API
  // in case an SSE event was missed (e.g. stale-reaper, zombie-reconciler,
  // or cancel API changed status without emitting via PG NOTIFY in older code).
  useEffect(() => {
    if (!sessionId) return;

    const pollTimer = setInterval(async () => {
      if (isDoneRef.current) return;
      try {
        const res = await fetch(`/api/sessions/${sessionId}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as { status: SessionStatus };
        if (data.status) {
          dispatch({ type: 'SET_STATUS', status: data.status });
          if (data.status === 'ended') {
            isDoneRef.current = true;
            markDone();
          }
        }
      } catch {
        // Polling is best-effort — SSE is the primary channel
      }
    }, STATUS_POLL_INTERVAL_MS);

    return () => clearInterval(pollTimer);
  }, [sessionId, markDone]);

  return {
    ...state,
    reset,
    loadOlderHistory,
    hasOlderHistory,
    isLoadingOlderHistory,
  };
}
