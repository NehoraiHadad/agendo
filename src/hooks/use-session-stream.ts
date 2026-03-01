'use client';

import { useReducer, useEffect, useCallback, useRef } from 'react';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';

interface SessionStreamState {
  events: AgendoEvent[];
  sessionStatus: SessionStatus | null;
  isConnected: boolean;
  error: string | null;
}

type StreamAction =
  | { type: 'APPEND_EVENT'; event: AgendoEvent }
  | { type: 'SET_STATUS'; status: SessionStatus }
  | { type: 'SET_CONNECTED'; connected: boolean }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'RESET' };

const MAX_EVENTS = 2000;

const initialState: SessionStreamState = {
  events: [],
  sessionStatus: null,
  isConnected: false,
  error: null,
};

function reducer(state: SessionStreamState, action: StreamAction): SessionStreamState {
  switch (action.type) {
    case 'APPEND_EVENT': {
      // Guard against duplicate delivery (e.g. SSE reconnect replaying already-seen events)
      if (action.event.id > 0 && state.events.some((e) => e.id === action.event.id)) {
        return state;
      }
      const events = [...state.events, action.event];
      const trimmed =
        events.length > MAX_EVENTS ? events.slice(events.length - MAX_EVENTS) : events;
      return { ...state, events: trimmed };
    }
    case 'SET_STATUS':
      return { ...state, sessionStatus: action.status };
    case 'SET_CONNECTED':
      return {
        ...state,
        isConnected: action.connected,
        error: action.connected ? null : state.error,
      };
    case 'SET_ERROR':
      return { ...state, error: action.error, isConnected: false };
    case 'RESET':
      return initialState;
    default:
      return state;
  }
}

export interface UseSessionStreamReturn extends SessionStreamState {
  reset: () => void;
}

export function useSessionStream(sessionId: string | null): UseSessionStreamReturn {
  const [state, dispatch] = useReducer(reducer, initialState);
  const retryDelayRef = useRef(1000);
  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef(0);
  const isDoneRef = useRef(false);

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
    lastEventIdRef.current = 0;
    isDoneRef.current = false;
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    dispatch({ type: 'RESET' });
    retryDelayRef.current = 1000;
    lastEventIdRef.current = 0;
    isDoneRef.current = false;

    function connect() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      // Build URL with lastEventId as query param for initial reconnect catchup.
      // The browser EventSource also sends Last-Event-ID header automatically on
      // subsequent reconnects, but the query param ensures the server can use it
      // on the very first client-initiated reconnect call.
      const lastId = lastEventIdRef.current;
      const url = `/api/sessions/${sessionId}/events${lastId > 0 ? `?lastEventId=${lastId}` : ''}`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        dispatch({ type: 'SET_CONNECTED', connected: true });
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
          const parsed = JSON.parse(event.data) as AgendoEvent;

          if (parsed.type === 'session:state') {
            dispatch({ type: 'SET_STATUS', status: parsed.status });
          } else {
            dispatch({ type: 'APPEND_EVENT', event: parsed });
          }
        } catch {
          // ignore malformed messages
        }
      };

      es.onerror = () => {
        es.close();
        dispatch({ type: 'SET_CONNECTED', connected: false });

        // Don't reconnect if session has ended
        if (isDoneRef.current) return;

        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, 30000);
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
  }, [sessionId]);

  return { ...state, reset };
}
