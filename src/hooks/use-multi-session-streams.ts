'use client';

import { useReducer, useEffect, useRef, useCallback, useMemo } from 'react';
import type { AgendoEvent, SessionStatus } from '@/lib/realtime/events';

const MAX_EVENTS_PER_PANEL = 500;
const MAX_CONCURRENT_CONNECTIONS = 6;

export interface PanelStreamState {
  events: AgendoEvent[];
  sessionStatus: SessionStatus | null;
  isConnected: boolean;
  error: string | null;
}

type MultiStreamAction =
  | { type: 'APPEND_EVENT'; sessionId: string; event: AgendoEvent }
  | { type: 'SET_STATUS'; sessionId: string; status: SessionStatus }
  | { type: 'SET_CONNECTED'; sessionId: string; connected: boolean }
  | { type: 'SET_ERROR'; sessionId: string; error: string }
  | { type: 'REMOVE_SESSION'; sessionId: string }
  | { type: 'RESET_SESSION'; sessionId: string };

type MultiStreamState = Record<string, PanelStreamState>;

function createInitialPanelState(): PanelStreamState {
  return {
    events: [],
    sessionStatus: null,
    isConnected: false,
    error: null,
  };
}

function reducer(state: MultiStreamState, action: MultiStreamAction): MultiStreamState {
  switch (action.type) {
    case 'APPEND_EVENT': {
      const existing = state[action.sessionId] ?? createInitialPanelState();
      const events = [...existing.events, action.event];
      const trimmed =
        events.length > MAX_EVENTS_PER_PANEL
          ? events.slice(events.length - MAX_EVENTS_PER_PANEL)
          : events;
      return { ...state, [action.sessionId]: { ...existing, events: trimmed } };
    }
    case 'SET_STATUS': {
      const existing = state[action.sessionId] ?? createInitialPanelState();
      return { ...state, [action.sessionId]: { ...existing, sessionStatus: action.status } };
    }
    case 'SET_CONNECTED': {
      const existing = state[action.sessionId] ?? createInitialPanelState();
      return {
        ...state,
        [action.sessionId]: {
          ...existing,
          isConnected: action.connected,
          error: action.connected ? null : existing.error,
        },
      };
    }
    case 'SET_ERROR': {
      const existing = state[action.sessionId] ?? createInitialPanelState();
      return {
        ...state,
        [action.sessionId]: { ...existing, error: action.error, isConnected: false },
      };
    }
    case 'REMOVE_SESSION': {
      const { [action.sessionId]: _removed, ...rest } = state;
      return rest;
    }
    case 'RESET_SESSION': {
      return { ...state, [action.sessionId]: createInitialPanelState() };
    }
    default:
      return state;
  }
}

// All mutable state that the connection logic needs, bundled into a single ref
// so the connect function can be a plain module-level helper (not a hook).
interface ConnectionContext {
  eventSources: Map<string, EventSource>;
  retryDelays: Map<string, number>;
  lastEventIds: Map<string, number>;
  isDone: Map<string, boolean>;
  isMounted: boolean;
  dispatch: React.Dispatch<MultiStreamAction>;
}

function openConnection(ctx: ConnectionContext, sessionId: string): void {
  // Close any existing connection for this session before opening a new one
  const existingEs = ctx.eventSources.get(sessionId);
  if (existingEs) {
    existingEs.close();
  }

  const lastId = ctx.lastEventIds.get(sessionId) ?? 0;
  const url = `/api/sessions/${sessionId}/events${lastId > 0 ? `?lastEventId=${lastId}` : ''}`;
  const es = new EventSource(url);
  ctx.eventSources.set(sessionId, es);

  es.onopen = () => {
    if (!ctx.isMounted) return;
    ctx.dispatch({ type: 'SET_CONNECTED', sessionId, connected: true });
    ctx.retryDelays.set(sessionId, 1000);
  };

  es.onmessage = (event) => {
    if (!ctx.isMounted) return;

    // Track last-event-id for reconnect
    if (event.lastEventId) {
      const id = parseInt(event.lastEventId, 10);
      const currentLast = ctx.lastEventIds.get(sessionId) ?? 0;
      if (!isNaN(id) && id > currentLast) {
        ctx.lastEventIds.set(sessionId, id);
      }
    }

    try {
      const parsed = JSON.parse(event.data) as AgendoEvent;

      if (parsed.type === 'session:state') {
        ctx.dispatch({ type: 'SET_STATUS', sessionId, status: parsed.status });
        // Mark done to stop reconnect attempts when session ends
        if (parsed.status === 'ended') {
          ctx.isDone.set(sessionId, true);
        }
      } else {
        ctx.dispatch({ type: 'APPEND_EVENT', sessionId, event: parsed });
      }
    } catch {
      // Ignore malformed messages
    }
  };

  es.onerror = () => {
    if (!ctx.isMounted) return;

    es.close();
    ctx.dispatch({ type: 'SET_CONNECTED', sessionId, connected: false });

    // Don't reconnect if session has ended
    if (ctx.isDone.get(sessionId)) return;

    const currentDelay = ctx.retryDelays.get(sessionId) ?? 1000;
    // Store the doubled delay for the *next* retry before scheduling this one
    ctx.retryDelays.set(sessionId, Math.min(currentDelay * 2, 30000));

    setTimeout(() => {
      // Guard at reconnect time — session may have been removed or component unmounted
      if (!ctx.isMounted) return;
      if (!ctx.eventSources.has(sessionId)) return;
      if (ctx.isDone.get(sessionId)) return;
      openConnection(ctx, sessionId);
    }, currentDelay);
  };
}

export interface UseMultiSessionStreamsReturn {
  streams: Map<string, PanelStreamState>;
  resetStream: (sessionId: string) => void;
}

export function useMultiSessionStreams(sessionIds: string[]): UseMultiSessionStreamsReturn {
  const [state, dispatch] = useReducer(reducer, {} as MultiStreamState);

  // All connection state lives in a single ref so openConnection can close over it
  const ctxRef = useRef<ConnectionContext>({
    eventSources: new Map(),
    retryDelays: new Map(),
    lastEventIds: new Map(),
    isDone: new Map(),
    isMounted: true,
    dispatch,
  });

  useEffect(() => {
    const ctx = ctxRef.current;
    ctx.isMounted = true;
    return () => {
      ctx.isMounted = false;
    };
  }, []);

  // Diff sessionIds changes: open new connections, close removed ones
  useEffect(() => {
    const ctx = ctxRef.current;

    // Enforce max concurrent connections
    const effectiveIds = sessionIds.slice(0, MAX_CONCURRENT_CONNECTIONS);
    const nextIdSet = new Set(effectiveIds);
    const currentIdSet = new Set(ctx.eventSources.keys());

    // Close and remove connections for sessions no longer in the list
    for (const sessionId of currentIdSet) {
      if (!nextIdSet.has(sessionId)) {
        const es = ctx.eventSources.get(sessionId);
        if (es) es.close();
        ctx.eventSources.delete(sessionId);
        ctx.retryDelays.delete(sessionId);
        ctx.lastEventIds.delete(sessionId);
        ctx.isDone.delete(sessionId);
        dispatch({ type: 'REMOVE_SESSION', sessionId });
      }
    }

    // Open connections for newly added sessions
    for (const sessionId of effectiveIds) {
      if (!currentIdSet.has(sessionId)) {
        ctx.retryDelays.set(sessionId, 1000);
        ctx.lastEventIds.set(sessionId, 0);
        ctx.isDone.set(sessionId, false);
        dispatch({ type: 'RESET_SESSION', sessionId });
        openConnection(ctx, sessionId);
      }
    }
  }, [sessionIds]);

  // Clean up all connections on unmount — capture the ref value inside the effect
  // so the cleanup function uses the same object even if the ref changes.
  useEffect(() => {
    const ctx = ctxRef.current;
    return () => {
      for (const es of ctx.eventSources.values()) {
        es.close();
      }
      ctx.eventSources.clear();
    };
  }, []);

  const resetStream = useCallback((sessionId: string) => {
    const ctx = ctxRef.current;
    ctx.lastEventIds.set(sessionId, 0);
    ctx.isDone.set(sessionId, false);
    ctx.retryDelays.set(sessionId, 1000);
    dispatch({ type: 'RESET_SESSION', sessionId });
    openConnection(ctx, sessionId);
  }, []);

  // Build the Map from the record state for the return API.
  // useMemo ensures a stable reference — only recreated when state changes,
  // preventing infinite loops in effects that depend on streams.
  const streams = useMemo(() => new Map<string, PanelStreamState>(Object.entries(state)), [state]);

  return { streams, resetStream };
}
