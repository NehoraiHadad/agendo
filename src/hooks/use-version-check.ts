'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string;
}

interface UseVersionCheckReturn {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function useVersionCheck(): UseVersionCheckReturn {
  const [data, setData] = useState<VersionCheckResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchVersion = useCallback(async (force = false) => {
    setIsLoading(true);
    try {
      const res = force
        ? await fetch('/api/version', { method: 'POST' })
        : await fetch('/api/version');
      if (res.ok) {
        const result = (await res.json()) as VersionCheckResult;
        setData(result);
      }
    } catch {
      // Silently fail — version check is non-critical
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    await fetchVersion(true);
  }, [fetchVersion]);

  useEffect(() => {
    // Initial fetch
    void fetchVersion();

    // Poll periodically
    intervalRef.current = setInterval(() => {
      void fetchVersion();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchVersion]);

  return {
    currentVersion: data?.currentVersion ?? process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
    latestVersion: data?.latestVersion ?? null,
    updateAvailable: data?.updateAvailable ?? false,
    checkedAt: data?.checkedAt ?? null,
    isLoading,
    refresh,
  };
}
