'use client';

import { useEffect, useRef, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { useGuideStore } from '@/lib/store/guide-store';

function slugify(step: string): string {
  return step
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function findGuideElement(slug: string): Element | null {
  return (
    document.querySelector(`[data-guide="${slug}"]`) ??
    document.querySelector(`[data-guide="nav-${slug}"]`) ??
    document.querySelector(`[data-guide="settings-${slug}"]`) ??
    document.querySelector(`[data-guide="project-${slug}"]`)
  );
}

/**
 * Headless component — renders nothing visible. Highlights DOM elements
 * matching the current guide step via `[data-guide]` attributes.
 *
 * On route change, advances to the next step (so multi-page guides work).
 * Highlights persist until: new steps arrive, popup closes, or all steps done.
 */
export function UiGuideOverlay() {
  const steps = useGuideStore((s) => s.steps);
  const stepIndex = useGuideStore((s) => s.stepIndex);
  // advanceStep is not used — we use setState directly for multi-step skipping
  const pathname = usePathname();
  const highlightedRefs = useRef<Set<Element>>(new Set());
  const prevPathnameRef = useRef(pathname);

  const cleanup = useCallback(() => {
    for (const el of highlightedRefs.current) {
      const html = el as HTMLElement;
      html.classList.remove('guide-highlight');
      for (let i = 1; i <= 4; i++) {
        html.classList.remove(`guide-highlight-${i}`);
      }
    }
    highlightedRefs.current.clear();
  }, []);

  // On route change: skip past steps that were already on the previous page.
  // E.g. "Sidebar → Settings → MCP Servers tab" — after navigating to /settings,
  // skip "Sidebar" and "Settings" (both were nav items on the old page) and jump
  // to "MCP Servers tab" which is the first step only on the new page.
  useEffect(() => {
    if (pathname !== prevPathnameRef.current) {
      prevPathnameRef.current = pathname;
      if (steps) {
        // Advance past all already-seen steps (stepIndex was the first highlighted step on the old page)
        // We need to find the first step NOT present on the old page. Since the old page is gone,
        // just advance past the ones that were highlighted (i.e., skip at least one step forward).
        // Advance until we hit a step whose element doesn't exist yet (it's on a future page)
        // or does exist (it's on this new page — start here).
        const { stepIndex: currentIdx } = useGuideStore.getState();
        let newIdx = currentIdx + 1;
        // Skip steps that are still nav-bar items (visible on every page)
        while (newIdx < steps.length) {
          const slug = slugify(steps[newIdx]);
          const isNavItem = !!document.querySelector(`[data-guide="nav-${slug}"]`);
          if (!isNavItem) break;
          newIdx++;
        }
        if (newIdx > currentIdx) {
          useGuideStore.setState({ stepIndex: newIdx });
        }
      }
    }
  }, [pathname, steps]);

  // Apply highlights for current step and all remaining steps visible on this page.
  // Uses MutationObserver to retry if elements aren't found immediately (e.g. after
  // route change, the new page's tabs may not have rendered yet).
  useEffect(() => {
    cleanup();

    if (!steps) return;

    const applyHighlights = () => {
      let allFound = true;
      for (let i = stepIndex; i < steps.length; i++) {
        const slug = slugify(steps[i]);
        const el = findGuideElement(slug);
        if (el && !highlightedRefs.current.has(el)) {
          const html = el as HTMLElement;
          const order = i - stepIndex + 1;
          html.classList.add('guide-highlight', `guide-highlight-${Math.min(order, 4)}`);
          highlightedRefs.current.add(el);
          if (order === 1) {
            html.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
        if (!el) allFound = false;
      }
      return allFound;
    };

    // Try immediately
    requestAnimationFrame(() => {
      if (applyHighlights()) return;

      // Not all elements found — watch for DOM changes (new page rendering)
      const observer = new MutationObserver(() => {
        if (applyHighlights()) {
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // Safety timeout — stop watching after 5s
      setTimeout(() => observer.disconnect(), 5000);
    });
  }, [steps, stepIndex, cleanup]);

  // Cleanup on unmount
  useEffect(() => cleanup, [cleanup]);

  return null;
}
