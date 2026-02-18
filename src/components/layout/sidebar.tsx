'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, ListTodo, Bot, Play, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface SidebarStats {
  runningExecutions: number;
  todoTasks: number;
}

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, badgeKey: null },
  { href: '/tasks', label: 'Tasks', icon: ListTodo, badgeKey: 'todoTasks' as const },
  { href: '/agents', label: 'Agents', icon: Bot, badgeKey: null },
  { href: '/executions', label: 'Executions', icon: Play, badgeKey: 'runningExecutions' as const },
];

export function Sidebar() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth < 640;
    }
    return false;
  });
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
        'flex h-full flex-col border-r bg-muted/40 transition-all duration-200',
        isCollapsed ? 'w-12 sm:w-16' : 'w-56',
      )}
    >
      <div className="flex h-14 items-center border-b px-4">
        {!isCollapsed && <span className="text-sm font-semibold">agenDo</span>}
        <Button
          variant="ghost"
          size="icon"
          className={cn('ml-auto h-8 w-8', isCollapsed && 'mx-auto')}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          const badgeCount = item.badgeKey && stats ? stats[item.badgeKey] : 0;

          const linkContent = (
            <Link
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                isCollapsed && 'justify-center px-2',
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!isCollapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  {badgeCount > 0 && (
                    <Badge
                      variant="secondary"
                      className="ml-auto h-5 min-w-5 justify-center px-1 text-xs"
                    >
                      {badgeCount}
                    </Badge>
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
    </aside>
  );
}
