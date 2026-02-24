'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

function checkShouldShow(): boolean {
  if (typeof window === 'undefined') return false;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  const dismissed = localStorage.getItem('pwa-ios-hint-dismissed');
  return isIOS && !isStandalone && !dismissed;
}

export function IosInstallHint() {
  // Lazy initializer runs once on mount (client-only; returns false on server)
  const [show, setShow] = useState<boolean>(checkShouldShow);

  if (!show) return null;

  const handleDismiss = () => {
    localStorage.setItem('pwa-ios-hint-dismissed', '1');
    setShow(false);
  };

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 rounded-lg border border-white/10 bg-card p-3 shadow-lg sm:left-auto sm:right-4 sm:w-72">
      <div className="flex items-start gap-2">
        <div className="flex-1 text-sm text-muted-foreground">
          Install agenDo: tap <span className="font-medium text-foreground">Share</span> then{' '}
          <span className="font-medium text-foreground">Add to Home Screen</span>
        </div>
        <button
          onClick={handleDismiss}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
