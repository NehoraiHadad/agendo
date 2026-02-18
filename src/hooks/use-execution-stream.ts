'use client';

import { useReducer, useEffect, useCallback, useRef } from 'react';
import {
  renderLogLine,
  renderLogChunk,
  resetLineIdCounter,
  type RenderedLine,
} from '@/lib/log-renderer';
import type { ExecutionStatus, SseLogEvent } from '@/lib/types';

const MAX_LINES = 5000;

interface StreamState {
  lines: RenderedLine[];
  status: ExecutionStatus | null;
  isDone: boolean;
  isConnected: boolean;
  error: string | null;
  isTruncated: boolean;
}

type StreamAction =
  | { type: 'APPEND_LINES'; lines: RenderedLine[] }
  | { type: 'REPLACE_LINES'; lines: RenderedLine[] }
  | { type: 'SET_STATUS'; status: ExecutionStatus }
  | { type: 'SET_DONE'; status: ExecutionStatus; exitCode: number | null }
  | { type: 'SET_CONNECTED'; connected: boolean }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'RESET' };

function appendWithWindow(
  existing: RenderedLine[],
  incoming: RenderedLine[],
): { lines: RenderedLine[]; isTruncated: boolean } {
  const combined = [...existing, ...incoming];
  if (combined.length > MAX_LINES) {
    return {
      lines: combined.slice(combined.length - MAX_LINES),
      isTruncated: true,
    };
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

export interface UseExecutionStreamReturn extends StreamState {
  reset: () => void;
}

export function useExecutionStream(executionId: string | null): UseExecutionStreamReturn {
  const [state, dispatch] = useReducer(reducer, initialState);
  const retryDelayRef = useRef(1000);
  const eventSourceRef = useRef<EventSource | null>(null);

  const reset = useCallback(() => {
    resetLineIdCounter();
    dispatch({ type: 'RESET' });
  }, []);

  useEffect(() => {
    if (!executionId) return;

    resetLineIdCounter();
    dispatch({ type: 'RESET' });
    retryDelayRef.current = 1000;

    function connect() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const es = new EventSource(`/api/executions/${executionId}/logs/stream`);
      eventSourceRef.current = es;

      es.onopen = () => {
        dispatch({ type: 'SET_CONNECTED', connected: true });
        retryDelayRef.current = 1000; // Reset backoff on successful connect
      };

      es.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as SseLogEvent;

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
              dispatch({ type: 'SET_DONE', status: parsed.status, exitCode: parsed.exitCode });
              es.close();
              break;

            case 'error':
              dispatch({ type: 'SET_ERROR', error: parsed.message });
              es.close();
              break;
          }
        } catch {
          // Ignore malformed messages
        }
      };

      es.onerror = () => {
        es.close();
        dispatch({ type: 'SET_CONNECTED', connected: false });

        // Don't reconnect if done
        if (state.isDone) return;

        // Exponential backoff reconnect
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
    // Only reconnect when executionId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionId]);

  return { ...state, reset };
}
