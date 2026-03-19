'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { getErrorMessage } from '@/lib/utils/error-utils';

interface UseFetchResult<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  refetch: () => void;
}

export function useFetch<T>(
  url: string | null,
  options?: {
    deps?: unknown[];
    transform?: (json: unknown) => T;
  },
): UseFetchResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const versionRef = useRef(0);

  const effectiveDeps = options?.deps ?? [];
  const transformRef = useRef(options?.transform);
  transformRef.current = options?.transform;

  const fetch_ = useCallback(() => {
    if (!url) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    const version = ++versionRef.current;

    setIsLoading(true);
    setError(null);

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json: unknown = await res.json();
        if (version !== versionRef.current) return;
        const result = transformRef.current ? transformRef.current(json) : (json as T);
        setData(result);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (version !== versionRef.current) return;
        setError(getErrorMessage(err));
      })
      .finally(() => {
        if (version === versionRef.current) setIsLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...effectiveDeps]);

  useEffect(() => {
    return fetch_();
  }, [fetch_]);

  return { data, error, isLoading, refetch: fetch_ };
}
