'use client';

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'agendo_onboarded';

function subscribe(onStoreChange: () => void) {
  // Re-check when other tabs update localStorage
  window.addEventListener('storage', onStoreChange);
  return () => window.removeEventListener('storage', onStoreChange);
}

function getSnapshot(): boolean {
  try {
    return !localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  // Always false on server — matches initial client render to avoid hydration mismatch
  return false;
}

export function useFirstRun() {
  const isFirstRun = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    // Trigger re-render by dispatching a storage event on the current window
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
  }, []);

  return { isFirstRun, dismiss };
}
