'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ListTodo, Bot, Play, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface SidebarStats {
  runningExecutions: number;
  todoTasks: number;
}

interface SidebarProps {
  onMobileClose?: () => void;
}

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, badgeKey: null },
  { href: '/tasks', label: 'Tasks', icon: ListTodo, badgeKey: 'todoTasks' as const },
  { href: '/agents', label: 'Agents', icon: Bot, badgeKey: null },
  { href: '/executions', label: 'Executions', icon: Play, badgeKey: 'runningExecutions' as const },
];

export function Sidebar({ onMobileClose }: SidebarProps) {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
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
        'relative flex h-full flex-col border-r border-white/[0.06] bg-[--sidebar] transition-all duration-300 ease-out',
        isCollapsed ? 'w-14' : 'w-60',
      )}
    >
      {/* Violet top gradient glow */}
      <div className="absolute top-0 left-0 right-0 h-32 pointer-events-none bg-gradient-to-b from-primary/8 to-transparent" />

      {/* Header */}
      <div className="relative flex h-14 items-center border-b border-white/[0.06] px-4 gap-2">
        {!isCollapsed && (
          <span className="flex-1 text-sm font-semibold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
            agenDo
          </span>
        )}

        {/* Mobile close button (only shown when used as overlay) */}
        {onMobileClose && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-white/[0.05] sm:hidden"
            onClick={onMobileClose}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </Button>
        )}

        {/* Collapse toggle (desktop) */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 hover:bg-white/[0.05] hidden sm:flex',
            isCollapsed && 'mx-auto',
          )}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>

      {/* Nav items */}
      <nav className="relative flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          const badgeCount = item.badgeKey && stats ? stats[item.badgeKey] : 0;

          const linkContent = (
            <Link
              href={item.href}
              onClick={onMobileClose}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-primary/15 text-primary border-l-2 border-primary glow-sm'
                  : 'text-muted-foreground/70 hover:text-foreground hover:bg-white/[0.04] rounded-md',
                isCollapsed && 'justify-center px-2',
              )}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              {!isCollapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {badgeCount > 0 && (
                    <span className="ml-auto bg-primary/20 text-primary text-[10px] rounded-full px-1.5 py-0.5 font-medium">
                      {badgeCount}
                    </span>
                  )}
                </>
              )}
            </Link>
          );

          if (isCollapsed) {
            return (
              <Tooltip key={item.href} delayDuration={0}>
                <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                <TooltipContent side="right">
                  {item.label}
                  {badgeCount > 0 && ` (${badgeCount})`}
                </TooltipContent>
              </Tooltip>
            );
          }

          return <div key={item.href}>{linkContent}</div>;
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-white/[0.06] p-2 mt-auto">
        {!isCollapsed && (
          <p className="text-[10px] text-muted-foreground/40 px-2 py-1 uppercase tracking-widest">
            v0.1
          </p>
        )}
      </div>
    </aside>
  );
}
