'use client';

import { useState, useEffect } from 'react';

/**
 * Returns true when the document matches the given CSS media query.
 * Returns false during SSR (no window available).
 */
export function useMediaQuery(query: string): boolean {
  // Initialize synchronously on the client so first render is correct (no flash)
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
