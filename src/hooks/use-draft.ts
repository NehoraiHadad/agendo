'use client';

import { useCallback, useEffect, useRef } from 'react';

const DEBOUNCE_MS = 300;

/**
 * Persist a draft value to localStorage with debounced writes.
 *
 * - `saveDraft(value)` — debounced write; clears storage immediately if value is empty
 * - `getDraft()` — synchronous read; returns null if no draft or storage unavailable
 * - `clearDraft()` — immediately removes the draft and cancels any pending write
 */
export function useDraft(key: string) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveDraft = useCallback(
    (value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (!value) {
        try {
          localStorage.removeItem(key);
        } catch {
          // ignore (private browsing, quota)
        }
        return;
      }
      timerRef.current = setTimeout(() => {
        try {
          localStorage.setItem(key, value);
        } catch {
          // ignore
        }
      }, DEBOUNCE_MS);
    },
    [key],
  );

  const getDraft = useCallback((): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }, [key]);

  const clearDraft = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }, [key]);

  // Cancel pending write on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { saveDraft, getDraft, clearDraft };
}
