'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { useDemoMode } from '@/hooks/use-demo-mode';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DemoBadgeProps {
  /** Called when the user clicks the badge (e.g. re-open intro popover). */
  onClick?: () => void;
  className?: string;
}

/**
 * A small amber chip that signals the app is running in demo mode.
 *
 * Returns `null` when demo mode is off.
 *
 * Accessibility: renders an `aria-live="polite"` announcement region on first
 * mount so screen-reader users learn about demo mode without being interrupted.
 */
export function DemoBadge({ onClick, className }: DemoBadgeProps): React.JSX.Element | null {
  const isDemo = useDemoMode();

  if (!isDemo) return null;

  return (
    <>
      {/* Screen-reader announcement — rendered once, polite so it doesn't interrupt */}
      <span className="sr-only" aria-live="polite" role="status">
        Demo mode is active. Actions that modify data are disabled.
      </span>
      <button
        type="button"
        onClick={onClick}
        aria-label="Demo mode — click to learn more"
        className={cn(
          'bg-amber-500/10 text-amber-700 dark:text-amber-300',
          'border border-amber-500/30',
          'px-2 py-0.5 rounded-full text-xs font-medium',
          'cursor-pointer transition-colors',
          'hover:bg-amber-500/20 focus-visible:outline-none',
          'focus-visible:ring-2 focus-visible:ring-amber-500/50',
          className,
        )}
      >
        DEMO
      </button>
    </>
  );
}
