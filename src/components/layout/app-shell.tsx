'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Menu } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sidebar } from './sidebar';
import { NotificationToggle } from '@/components/pwa/notification-toggle';
import { IosInstallHint } from '@/components/pwa/ios-install-hint';
import { InstallPrompt } from '@/components/pwa/install-prompt';
import { cn } from '@/lib/utils';

const CommandPalette = dynamic(
  () => import('@/components/command-palette').then((m) => ({ default: m.CommandPalette })),
  { ssr: false },
);

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <TooltipProvider>
      <CommandPalette />
      <div className="fixed inset-0 flex overflow-hidden">
        {/* Mobile backdrop */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm sm:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}

        {/* Sidebar — hidden on mobile unless open, always visible sm+ */}
        <div
          className={cn(
            'shrink-0',
            'fixed inset-y-0 left-0 z-50 sm:static sm:z-auto sm:flex',
            mobileOpen ? 'flex' : 'hidden sm:flex',
          )}
        >
          <Sidebar onMobileClose={() => setMobileOpen(false)} />
        </div>

        {/* Main content area */}
        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          {/* Mobile top bar */}
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.05] bg-[--sidebar] px-3 sm:hidden">
            <button
              onClick={() => setMobileOpen(true)}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground/60 hover:text-foreground/80 hover:bg-white/[0.06] active:scale-95 transition-all duration-150"
              aria-label="Open navigation"
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="flex-1 text-sm font-semibold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
              agenDo
            </span>
            <NotificationToggle />
          </header>
          <IosInstallHint />
          <InstallPrompt />

          <main className="flex-1 min-h-0 flex flex-col overflow-y-auto p-4 sm:p-6 animate-fade-in-up">
            {children}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
