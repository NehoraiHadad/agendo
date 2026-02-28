'use client';

import { useState, useEffect, useSyncExternalStore, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ListTodo,
  Bot,
  Play,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  X,
  Wrench,
  FolderOpen,
  FileText,
  PanelTop,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import Image from 'next/image';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface SidebarStats {
  runningExecutions: number;
  todoTasks: number;
  activeSessions: number;
}

interface SidebarProps {
  onMobileClose?: () => void;
}

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, badgeKey: null },
  { href: '/projects', label: 'Projects', icon: FolderOpen, badgeKey: null },
  { href: '/tasks', label: 'Tasks', icon: ListTodo, badgeKey: 'todoTasks' as const },
  { href: '/agents', label: 'AI Agents', icon: Bot, badgeKey: null },
  { href: '/tools', label: 'Tools', icon: Wrench, badgeKey: null },
  {
    href: '/sessions',
    label: 'Sessions',
    icon: MessageSquare,
    badgeKey: 'activeSessions' as const,
  },
  { href: '/executions', label: 'Executions', icon: Play, badgeKey: 'runningExecutions' as const },
  { href: '/plans', label: 'Plans', icon: FileText, badgeKey: null },
  { href: '/workspace', label: 'Workspace', icon: PanelTop, badgeKey: null },
  { href: '/config', label: 'Config', icon: Settings, badgeKey: null },
];

const SIDEBAR_KEY = 'sidebar-collapsed';
const subscribeSidebarStorage = (cb: () => void) => {
  window.addEventListener('storage', cb);
  return () => window.removeEventListener('storage', cb);
};
const getSidebarSnapshot = () => localStorage.getItem(SIDEBAR_KEY) === 'true';
const getSidebarServerSnapshot = () => false;

export function Sidebar({ onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const isCollapsed = useSyncExternalStore(
    subscribeSidebarStorage,
    getSidebarSnapshot,
    getSidebarServerSnapshot,
  );
  const setIsCollapsed = useCallback((value: boolean) => {
    localStorage.setItem(SIDEBAR_KEY, String(value));
    // Trigger re-render by dispatching a storage event on the current window
    window.dispatchEvent(new StorageEvent('storage', { key: SIDEBAR_KEY }));
  }, []);
  const [stats, setStats] = useState<SidebarStats | null>(null);

  useEffect(() => {
    async function fetchStats() {
      try {
        const res = await fetch('/api/stats');
        const json = await res.json();
        setStats(json.data);
      } catch {
        /* ignore */
      }
    }
    fetchStats();
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, []);

  return (
    <aside
      className={cn(
        'relative flex h-full flex-col bg-[--sidebar] transition-all duration-300 ease-out overflow-hidden',
        'border-r border-white/[0.05]',
        isCollapsed ? 'w-14' : 'w-60',
      )}
    >
      {/* Violet atmospheric glow — top */}
      <div
        className="absolute top-0 left-0 right-0 h-48 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 130% 80% at -10% 0%, oklch(0.7 0.18 280 / 0.07) 0%, transparent 70%)',
        }}
      />

      {/* Header */}
      <div className="relative flex h-14 items-center border-b border-white/[0.05] px-3 gap-2 shrink-0">
        <Link href="/" className="flex items-center gap-2.5 flex-1 overflow-hidden">
          {/* Logo container */}
          <div
            className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl overflow-hidden"
            style={{
              background:
                'linear-gradient(135deg, oklch(0.7 0.18 280 / 0.2) 0%, oklch(0.6 0.2 260 / 0.12) 100%)',
              boxShadow: '0 0 12px oklch(0.7 0.18 280 / 0.18), inset 0 1px 0 oklch(1 0 0 / 0.10)',
              border: '1px solid oklch(0.7 0.18 280 / 0.22)',
            }}
          >
            <Image
              src="/logo.png"
              alt="agendo"
              width={32}
              height={32}
              className="h-full w-full object-cover mix-blend-screen scale-110"
            />
          </div>

          {!isCollapsed && (
            <div className="flex flex-col min-w-0 overflow-hidden">
              <span className="text-sm font-bold tracking-tight truncate text-gradient-primary">
                agenDo
              </span>
              <span className="text-[9px] text-muted-foreground/25 uppercase tracking-widest -mt-0.5">
                AI Orchestrator
              </span>
            </div>
          )}
        </Link>

        {/* Mobile close */}
        {onMobileClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-white/[0.05] sm:hidden shrink-0"
            onClick={onMobileClose}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </Button>
        )}

        {/* Collapse toggle */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-7 w-7 hover:bg-white/[0.05] hidden sm:flex shrink-0 text-muted-foreground/35 hover:text-muted-foreground transition-colors',
            isCollapsed && 'mx-auto',
          )}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Nav section label */}
      {!isCollapsed && (
        <div className="px-4 pt-4 pb-1">
          <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/20">
            Navigation
          </span>
        </div>
      )}

      {/* Nav items */}
      <nav className="relative flex-1 space-y-0.5 px-2 py-1">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          const badgeCount = item.badgeKey && stats ? stats[item.badgeKey] : 0;

          const linkContent = (
            <Link
              href={item.href}
              onClick={onMobileClose}
              className={cn(
                'relative flex items-center gap-3 px-3 py-2.5 text-[13px] font-medium rounded-lg transition-all duration-150 group',
                'min-h-[40px]',
                isActive
                  ? 'bg-primary/[0.12] text-primary'
                  : 'text-muted-foreground/55 hover:text-foreground/80 hover:bg-white/[0.04]',
                isCollapsed && 'justify-center px-0',
              )}
            >
              {/* Active left indicator bar */}
              {isActive && (
                <span
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r-full bg-primary"
                  style={{ boxShadow: '2px 0 8px oklch(0.7 0.18 280 / 0.5)' }}
                />
              )}

              {/* Icon */}
              <item.icon
                className={cn(
                  'h-4 w-4 shrink-0 transition-colors',
                  isActive
                    ? 'text-primary'
                    : 'text-muted-foreground/45 group-hover:text-foreground/65',
                )}
              />

              {!isCollapsed && (
                <>
                  <span className="flex-1 leading-none">{item.label}</span>
                  {badgeCount > 0 && (
                    <span
                      className={cn(
                        'ml-auto rounded-full px-1.5 py-0.5 text-[9px] font-bold tabular-nums',
                        isActive
                          ? 'bg-primary/25 text-primary'
                          : 'bg-white/[0.07] text-muted-foreground/55',
                      )}
                    >
                      {badgeCount}
                    </span>
                  )}
                </>
              )}

              {/* Collapsed: badge dot */}
              {isCollapsed && badgeCount > 0 && (
                <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              )}
            </Link>
          );

          if (isCollapsed) {
            return (
              <Tooltip key={item.href} delayDuration={0}>
                <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {item.label}
                  {badgeCount > 0 && <span className="ml-1.5 text-primary/80">({badgeCount})</span>}
                </TooltipContent>
              </Tooltip>
            );
          }

          return <div key={item.href}>{linkContent}</div>;
        })}
      </nav>

      {/* Footer */}
      <div className="relative border-t border-white/[0.04] p-3 mt-auto">
        {!isCollapsed ? (
          <div className="flex items-center gap-2 px-1">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/60 animate-pulse shrink-0" />
            <span className="text-[9px] text-muted-foreground/25 uppercase tracking-widest">
              v0.1 · Online
            </span>
          </div>
        ) : (
          <div className="flex justify-center">
            <span
              className="h-1.5 w-1.5 rounded-full bg-emerald-400/50 animate-pulse"
              title="Online"
            />
          </div>
        )}
      </div>
    </aside>
  );
}
