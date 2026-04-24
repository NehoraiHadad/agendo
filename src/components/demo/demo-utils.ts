import type React from 'react';

// ---------------------------------------------------------------------------
// DemoBadge helpers
// ---------------------------------------------------------------------------

/** Returns true when the badge should render (i.e. demo mode is active). */
export function demoBadgeShouldRender(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
}

// ---------------------------------------------------------------------------
// DemoGuard helpers
// ---------------------------------------------------------------------------

export const DEMO_GUARD_DEFAULT_MESSAGE = 'Not available in demo — install locally to try it.';

/** Returns the effective tooltip message. */
export function resolveDemoMessage(override: string | undefined): string {
  return override ?? DEMO_GUARD_DEFAULT_MESSAGE;
}

/**
 * Builds a wrapped click handler.
 *
 * In demo mode: prevents default, stops propagation, does NOT call original.
 * In non-demo mode: delegates to the original handler unchanged.
 */
export function buildDemoClickHandler(
  isDemoBlocked: boolean,
  original: React.MouseEventHandler | undefined,
): React.MouseEventHandler {
  return (e: React.MouseEvent) => {
    if (isDemoBlocked) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    original?.(e);
  };
}

// ---------------------------------------------------------------------------
// DemoIntroPopover helpers
// ---------------------------------------------------------------------------

/** localStorage key used to persist dismissal. */
export const DEMO_INTRO_DISMISSED_KEY = 'agendo-demo-intro-dismissed';

/**
 * Returns true when the intro should auto-open.
 * @param storedValue - the raw value from localStorage.getItem(), or null if absent.
 */
export function shouldAutoOpen(storedValue: string | null): boolean {
  return storedValue !== '1';
}

/** Returns the "install locally" link. */
export function getInstallLink(): string {
  return 'https://github.com/nehorai-hadad/agendo#readme';
}
