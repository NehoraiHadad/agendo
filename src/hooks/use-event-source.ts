'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

const BASE_RETRY_DELAY = 1000;
const MAX_RETRY_DELAY = 30_000;

interface UseEventSourceOptions {
  /** SSE endpoint URL. null disables the connection. */
  url: string | null;
  /** Append ?lastEventId=N to URL when reconnecting. Default: true */
  trackLastEventId?: boolean;
  /** Called with parsed JSON for each SSE message. */
  onMessage: (data: unknown, rawEvent: MessageEvent) => void;
  /** Called when connection opens successfully. */
  onOpen?: () => void;
  /** Called just before a reconnect attempt (e.g. to reset local state). */
  onReconnect?: () => void;
  /**
   * Named SSE event types to listen for (via addEventListener).
   * If provided, `onMessage` receives both unnamed and named events.
   * Each named event's data is JSON-parsed before being passed to `onMessage`.
   */
  eventNames?: string[];
}

interface UseEventSourceReturn {
  isConnected: boolean;
  error: string | null;
  /** Permanently stop reconnecting (e.g. session/room ended). */
  markDone: () => void;
  /** Reset the tracked lastEventId to 0. */
  resetLastEventId: () => void;
  /** Manually set the tracked lastEventId (for custom ID logic). */
  setLastEventId: (id: number) => void;
}

export function useEventSource(options: UseEventSourceOptions): UseEventSourceReturn {
  const { url, trackLastEventId = true } = options;

  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable ref for callbacks so the effect doesn't re-run when they change.
  // Updated via a no-deps effect that runs after every render.
  const callbacksRef = useRef(options);
  useEffect(() => {
    callbacksRef.current = options;
  });

  const esRef = useRef<EventSource | null>(null);
  const retryDelayRef = useRef(BASE_RETRY_DELAY);
  const lastEventIdRef = useRef(0);
  const isDoneRef = useRef(false);
  const isMountedRef = useRef(true);

  const markDone = useCallback(() => {
    isDoneRef.current = true;
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const resetLastEventId = useCallback(() => {
    lastEventIdRef.current = 0;
  }, []);

  const setLastEventId = useCallback((id: number) => {
    lastEventIdRef.current = id;
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    if (!url) {
      return () => {
        isMountedRef.current = false;
      };
    }

    // Reset refs for new URL
    retryDelayRef.current = BASE_RETRY_DELAY;
    lastEventIdRef.current = 0;
    isDoneRef.current = false;

    // Capture url in a local const so TypeScript knows it's non-null in connect()
    const activeUrl = url;

    function connect() {
      if (!isMountedRef.current || isDoneRef.current) return;

      if (esRef.current) {
        esRef.current.close();
      }

      const lastId = lastEventIdRef.current;
      const finalUrl =
        trackLastEventId && lastId > 0
          ? `${activeUrl}${activeUrl.includes('?') ? '&' : '?'}lastEventId=${lastId}`
          : activeUrl;

      const es = new EventSource(finalUrl);
      esRef.current = es;

      es.onopen = () => {
        if (!isMountedRef.current) return;
        setIsConnected(true);
        setError(null);
        retryDelayRef.current = BASE_RETRY_DELAY;
        callbacksRef.current.onOpen?.();
      };

      es.onmessage = (event: MessageEvent) => {
        if (!isMountedRef.current) return;

        try {
          const data: unknown = JSON.parse(event.data as string);
          callbacksRef.current.onMessage(data, event);
        } catch {
          // Ignore malformed messages
        }
      };

      // Listen for named SSE events (e.g., "snapshot", "task_updated")
      const names = callbacksRef.current.eventNames;
      if (names) {
        for (const name of names) {
          es.addEventListener(name, ((event: MessageEvent) => {
            if (!isMountedRef.current) return;
            try {
              const data: unknown = JSON.parse(event.data as string);
              callbacksRef.current.onMessage(data, event);
            } catch {
              // Ignore malformed messages
            }
          }) as EventListener);
        }
      }

      es.onerror = () => {
        if (!isMountedRef.current) return;

        es.close();
        setIsConnected(false);

        if (isDoneRef.current) return;

        callbacksRef.current.onReconnect?.();

        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, MAX_RETRY_DELAY);
        setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      isMountedRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [url, trackLastEventId]);

  return { isConnected, error, markDone, resetLastEventId, setLastEventId };
}
