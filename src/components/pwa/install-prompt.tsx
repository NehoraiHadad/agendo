'use client';

import { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (localStorage.getItem('pwa-install-dismissed')) return;
    if (window.matchMedia('(display-mode: standalone)').matches) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setPromptEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);

    const installedHandler = () => setPromptEvent(null);
    window.addEventListener('appinstalled', installedHandler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installedHandler);
    };
  }, []);

  if (!promptEvent) return null;

  const handleInstall = async () => {
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'accepted') {
      setPromptEvent(null);
    }
  };

  const handleDismiss = () => {
    localStorage.setItem('pwa-install-dismissed', '1');
    setPromptEvent(null);
  };

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 rounded-lg border border-white/10 bg-card p-3 shadow-lg sm:left-auto sm:right-4 sm:w-72">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="flex-1 text-sm text-muted-foreground">
          Install <span className="font-medium text-foreground">agenDo</span> as an app
        </div>
        <button
          onClick={() => void handleInstall()}
          className="shrink-0 rounded px-2 py-0.5 text-xs font-medium text-primary hover:text-primary/80"
        >
          Install
        </button>
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
