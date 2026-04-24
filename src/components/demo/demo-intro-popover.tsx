'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useDemoMode } from '@/hooks/use-demo-mode';
import { DEMO_INTRO_DISMISSED_KEY, shouldAutoOpen, getInstallLink } from './demo-utils';

export { DEMO_INTRO_DISMISSED_KEY };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DemoIntroPopoverProps {
  /**
   * When provided, puts the dialog in controlled mode.
   * Parent drives open state.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * First-visit dialog introducing demo mode.
 *
 * Uncontrolled mode (default): auto-opens on first mount unless the user has
 * previously dismissed it (persisted in localStorage).
 *
 * Controlled mode: when `open` is provided, the parent drives state.
 *
 * Returns `null` when demo mode is off.
 *
 * SSR-safe: localStorage is only accessed inside useEffect.
 */
export function DemoIntroPopover({
  open: controlledOpen,
  onOpenChange,
}: DemoIntroPopoverProps = {}): React.JSX.Element | null {
  const isDemo = useDemoMode();
  const isControlled = controlledOpen !== undefined;

  // Uncontrolled state — start closed; effect will open if needed
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);

  React.useEffect(() => {
    if (!isDemo) return;
    if (isControlled) return;
    // SSR-safe: localStorage is only accessed here
    const stored = localStorage.getItem(DEMO_INTRO_DISMISSED_KEY);
    if (shouldAutoOpen(stored)) {
      setUncontrolledOpen(true);
    }
  }, [isDemo, isControlled]);

  if (!isDemo) return null;

  const isOpen = isControlled ? (controlledOpen ?? false) : uncontrolledOpen;

  function handleOpenChange(next: boolean) {
    if (!next) {
      if (!isControlled) {
        localStorage.setItem(DEMO_INTRO_DISMISSED_KEY, '1');
        setUncontrolledOpen(false);
      }
    }
    onOpenChange?.(next);
  }

  function handleDismiss() {
    handleOpenChange(false);
  }

  const installLink = getInstallLink();

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-md">
        <DialogHeader>
          <DialogTitle>Welcome to the Agendo Demo</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          This is a read-only demo with fake data. Drag tasks across columns, open sessions to watch
          live-stream replays, browse every page. Actions that modify real state are disabled —{' '}
          <a
            href={installLink}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground transition-colors"
          >
            install locally
          </a>{' '}
          to try them.
        </p>
        <DialogFooter>
          <Button onClick={handleDismiss} variant="default" size="sm">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
