'use client';

import { useReducer, useEffect, useCallback, useRef } from 'react';
import {
  renderLogLine,
  renderLogChunk,
  resetLineIdCounter,
  type RenderedLine,
} from '@/lib/log-renderer';
import type { SseLogEvent } from '@/lib/types';
import type { UseExecutionStreamReturn } from './use-execution-stream';

// Re-export type alias for downstream use
export type UseSessionLogStreamReturn = UseExecutionStreamReturn;

// Cast helper — session statuses don't overlap with ExecutionStatus but the
// viewer only uses status for display, so casting is safe here.
function asExecutionStatus(s: string | null): UseExecutionStreamReturn['status'] {
  return s as UseExecutionStreamReturn['status'];
}

const MAX_LINES = 5000;

interface StreamState {
  lines: RenderedLine[];
  status: string | null;
  isDone: boolean;
  isConnected: boolean;
  error: string | null;
  isTruncated: boolean;
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
      return { ...state, isConnected: action.connected, error: action.connected ? null : state.error };
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
  const retryDelayRef = useRef(1000);
  const eventSourceRef = useRef<EventSource | null>(null);

  const reset = useCallback(() => {
    resetLineIdCounter();
    dispatch({ type: 'RESET' });
  }, []);

  useEffect(() => {
    if (!sessionId) return;

    resetLineIdCounter();
    dispatch({ type: 'RESET' });
    retryDelayRef.current = 1000;

    function connect() {
      if (eventSourceRef.current) eventSourceRef.current.close();

      const es = new EventSource(`/api/sessions/${sessionId}/logs/stream`);
      eventSourceRef.current = es;

      es.onopen = () => {
        dispatch({ type: 'SET_CONNECTED', connected: true });
        retryDelayRef.current = 1000;
      };

      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data as string) as SseLogEvent;
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
              es.close();
              break;
            case 'error':
              dispatch({ type: 'SET_ERROR', error: parsed.message });
              es.close();
              break;
          }
        } catch { /* ignore malformed */ }
      };

      es.onerror = () => {
        es.close();
        dispatch({ type: 'SET_CONNECTED', connected: false });
        if (state.isDone) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return { ...state, status: asExecutionStatus(state.status), reset };
}
