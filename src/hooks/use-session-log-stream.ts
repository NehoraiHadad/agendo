'use client';

import { useReducer, useEffect, useCallback } from 'react';
import {
  renderLogLine,
  renderLogChunk,
  resetLineIdCounter,
  type RenderedLine,
  type StreamType,
} from '@/lib/log-renderer';
import { useEventSource } from './use-event-source';

type SseLogEvent =
  | { type: 'status'; status: string }
  | { type: 'catchup'; content: string }
  | { type: 'log'; content: string; stream: StreamType }
  | { type: 'done'; status: string }
  | { type: 'error'; message: string };

const MAX_LINES = 5000;

interface StreamState {
  lines: RenderedLine[];
  status: string | null;
  isDone: boolean;
  isConnected: boolean;
  error: string | null;
  isTruncated: boolean;
}

export interface UseSessionLogStreamReturn extends StreamState {
  reset: () => void;
}

type StreamAction =
  | { type: 'APPEND_LINES'; lines: RenderedLine[] }
  | { type: 'REPLACE_LINES'; lines: RenderedLine[] }
  | { type: 'SET_STATUS'; status: string }
  | { type: 'SET_DONE'; status: string }
  | { type: 'SET_CONNECTED'; connected: boolean }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'RESET' };

function appendWithWindow(
  existing: RenderedLine[],
  incoming: RenderedLine[],
): { lines: RenderedLine[]; isTruncated: boolean } {
  const combined = [...existing, ...incoming];
  if (combined.length > MAX_LINES) {
    return { lines: combined.slice(combined.length - MAX_LINES), isTruncated: true };
  }
  return { lines: combined, isTruncated: existing.length > MAX_LINES };
}

const initialState: StreamState = {
  lines: [],
  status: null,
  isDone: false,
  isConnected: false,
  error: null,
  isTruncated: false,
};

function reducer(state: StreamState, action: StreamAction): StreamState {
  switch (action.type) {
    case 'APPEND_LINES': {
      const { lines, isTruncated } = appendWithWindow(state.lines, action.lines);
      return { ...state, lines, isTruncated: state.isTruncated || isTruncated };
    }
    case 'REPLACE_LINES': {
      const { lines, isTruncated } = appendWithWindow([], action.lines);
      return { ...state, lines, isTruncated };
    }
    case 'SET_STATUS':
      return { ...state, status: action.status };
    case 'SET_DONE':
      return { ...state, isDone: true, status: action.status, isConnected: false };
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

export function useSessionLogStream(sessionId: string | null): UseSessionLogStreamReturn {
  const [state, dispatch] = useReducer(reducer, initialState);

  const reset = useCallback(() => {
    resetLineIdCounter();
    dispatch({ type: 'RESET' });
  }, []);

  const url = sessionId ? `/api/sessions/${sessionId}/logs/stream` : null;

  const { isConnected, error, markDone } = useEventSource({
    url,
    trackLastEventId: false,
    onOpen: () => {
      dispatch({ type: 'SET_CONNECTED', connected: true });
    },
    onMessage: (data: unknown) => {
      const parsed = data as SseLogEvent;
      switch (parsed.type) {
        case 'status':
          dispatch({ type: 'SET_STATUS', status: parsed.status });
          break;
        case 'catchup': {
          const lines = renderLogChunk(parsed.content, 'stdout');
          dispatch({ type: 'REPLACE_LINES', lines });
          break;
        }
        case 'log': {
          const line = renderLogLine(parsed.content, parsed.stream);
          dispatch({ type: 'APPEND_LINES', lines: [line] });
          break;
        }
        case 'done':
          dispatch({ type: 'SET_DONE', status: parsed.status });
          markDone();
          break;
        case 'error':
          dispatch({ type: 'SET_ERROR', error: parsed.message });
          markDone();
          break;
      }
    },
  });

  // Sync connection state from useEventSource into reducer
  useEffect(() => {
    dispatch({ type: 'SET_CONNECTED', connected: isConnected });
  }, [isConnected]);

  useEffect(() => {
    if (error) {
      dispatch({ type: 'SET_ERROR', error });
    }
  }, [error]);

  // Reset line counter when sessionId changes
  useEffect(() => {
    resetLineIdCounter();
    dispatch({ type: 'RESET' });
  }, [sessionId]);

  return { ...state, reset };
}
