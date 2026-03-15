'use client';

import { useState } from 'react';

const STORAGE_KEY = 'agendo_onboarded';

function checkFirstRun(): boolean {
  try {
    return !localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable (SSR or private mode)
    return false;
  }
}

export function useFirstRun() {
  const [isFirstRun, setIsFirstRun] = useState<boolean>(checkFirstRun);

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
    setIsFirstRun(false);
  }

  return { isFirstRun, dismiss };
}
