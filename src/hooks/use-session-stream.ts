'use client';

import { useReducer, useEffect, useCallback, useRef } from 'react';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';
import { appendWithWindow } from '@/lib/utils/event-window';
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
  | { type: 'SET_STATUS'; status: SessionStatus };

const MAX_EVENTS = 2000;

const initialState: SessionStreamState = {
  events: [],
  sessionStatus: null,
  permissionMode: null,
  isConnected: false,
  error: null,
};

const reducer = createStreamReducer<SessionStreamState, CustomAction>(
  initialState,
  (state, action) => {
    switch (action.type) {
      case 'APPEND_EVENT': {
        // Guard against duplicate delivery (e.g. SSE reconnect replaying already-seen events).
        // id: 0 is used by synthetic/meta events (e.g. the log-fallback reconnect marker);
        // those must also be deduped — without this guard they bypass dedup on every reconnect
        // and produce duplicate React keys (e.g. `info-0`).
        if (state.events.some((e) => e.id === action.event.id)) {
          return state;
        }
        const { items: trimmed } = appendWithWindow(state.events, action.event, MAX_EVENTS);
        // Track permission mode changes in real-time.
        const newMode =
          action.event.type === 'session:mode-change' ? action.event.mode : state.permissionMode;
        return { ...state, events: trimmed, permissionMode: newMode };
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
}

/** Polling interval for status reconciliation fallback (30s). */
const STATUS_POLL_INTERVAL_MS = 30_000;

export function useSessionStream(sessionId: string | null): UseSessionStreamReturn {
  const [state, dispatch] = useReducer(reducer, initialState);
  const isDoneRef = useRef(false);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
    isDoneRef.current = false;
  }, []);

  const url = sessionId ? `/api/sessions/${sessionId}/events` : null;

  const { isConnected, error, markDone, resetLastEventId, setLastEventId } = useEventSource({
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
        dispatch({ type: 'SET_STATUS', status: parsed.status });
        if (parsed.status === 'ended') {
          isDoneRef.current = true;
          markDone();
        }
      } else {
        dispatch({ type: 'APPEND_EVENT', event: parsed });
      }
    },
    onReconnect: () => {
      // Reset event state on reconnect to prevent duplicates from stale events.
      // Also reset lastEventIdRef so the server knows to send full history again
      // (server skips CLI-native history replay when lastEventId > 0).
      dispatch({ type: 'RESET' });
      resetLastEventId();
    },
  });

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
    dispatch({ type: 'RESET' });
    isDoneRef.current = false;
  }, [sessionId]);

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

  return { ...state, reset };
}
