'use client';

import { useState, useEffect } from 'react';
import dynamic from 'next/dynamic';
import { Menu } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sidebar } from './sidebar';
import { NotificationToggle } from '@/components/pwa/notification-toggle';
import { IosInstallHint } from '@/components/pwa/ios-install-hint';
import { InstallPrompt } from '@/components/pwa/install-prompt';
import { cn } from '@/lib/utils';

interface SystemStats {
  cpu: number;
  mem: number;
  disk: number;
}

function metricBarColor(pct: number) {
  if (pct >= 85) return 'bg-red-400';
  if (pct >= 65) return 'bg-amber-400';
  return 'bg-emerald-400/60';
}

function MobileNavTrigger({ onClick, stats }: { onClick: () => void; stats: SystemStats | null }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open navigation"
      className="flex h-9 w-9 flex-col items-center justify-center gap-1 rounded-xl hover:bg-white/[0.06] active:scale-95 transition-all duration-150"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/50 animate-pulse" />
      {stats ? (
        <div className="flex flex-col gap-0.5 w-5">
          <div className="w-full h-0.5 bg-white/[0.06] rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-700',
                metricBarColor(stats.mem),
              )}
              style={{ width: `${stats.mem}%` }}
            />
          </div>
          <div className="w-full h-0.5 bg-white/[0.06] rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-700',
                metricBarColor(stats.disk),
              )}
              style={{ width: `${stats.disk}%` }}
            />
          </div>
        </div>
      ) : (
        <Menu className="h-4 w-4 text-muted-foreground/50" />
      )}
    </button>
  );
}

const CommandPalette = dynamic(
  () => import('@/components/command-palette').then((m) => ({ default: m.CommandPalette })),
  { ssr: false },
);

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sysStats, setSysStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    async function fetchSysStats() {
      try {
        const res = await fetch('/api/system-stats');
        if (!res.ok) return;
        const json = await res.json();
        setSysStats({ cpu: json.data.cpu, mem: json.data.mem, disk: json.data.disk });
      } catch {
        /* ignore */
      }
    }
    fetchSysStats();
    const interval = setInterval(fetchSysStats, 30_000);
    return () => clearInterval(interval);
  }, []);

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
            <MobileNavTrigger onClick={() => setMobileOpen(true)} stats={sysStats} />
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
