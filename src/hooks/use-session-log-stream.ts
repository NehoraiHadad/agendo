'use client';

import { useReducer, useEffect, useCallback } from 'react';
import {
  renderLogLine,
  renderLogChunk,
  resetLineIdCounter,
  type RenderedLine,
  type StreamType,
} from '@/lib/log-renderer';
import { appendWithWindow } from '@/lib/utils/event-window';
import { createStreamReducer } from './create-stream-reducer';
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

type CustomAction =
  | { type: 'APPEND_LINES'; lines: RenderedLine[] }
  | { type: 'REPLACE_LINES'; lines: RenderedLine[] }
  | { type: 'SET_STATUS'; status: string }
  | { type: 'SET_DONE'; status: string };

function appendLines(
  existing: RenderedLine[],
  incoming: RenderedLine[],
): { lines: RenderedLine[]; isTruncated: boolean } {
  const { items, truncated } = appendWithWindow(existing, incoming, MAX_LINES);
  return { lines: items, isTruncated: truncated };
}

const initialState: StreamState = {
  lines: [],
  status: null,
  isDone: false,
  isConnected: false,
  error: null,
  isTruncated: false,
};

const reducer = createStreamReducer<StreamState, CustomAction>(initialState, (state, action) => {
  switch (action.type) {
    case 'APPEND_LINES': {
      const { lines, isTruncated } = appendLines(state.lines, action.lines);
      return { ...state, lines, isTruncated: state.isTruncated || isTruncated };
    }
    case 'REPLACE_LINES': {
      const { lines, isTruncated } = appendLines([], action.lines);
      return { ...state, lines, isTruncated };
    }
    case 'SET_STATUS':
      return { ...state, status: action.status };
    case 'SET_DONE':
      return { ...state, isDone: true, status: action.status, isConnected: false };
    default:
      return undefined;
  }
});

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
