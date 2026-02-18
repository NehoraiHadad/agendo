import { Card, CardContent } from '@/components/ui/card';
import { ListTodo, Play, Clock, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DashboardStats } from '@/lib/services/dashboard-service';

interface StatsGridProps {
  stats: DashboardStats;
}

const METRIC_CONFIGS = [
  {
    title: 'TOTAL TASKS',
    key: 'totalTasks' as const,
    icon: ListTodo,
    borderColor: 'border-blue-500/60',
    iconColor: 'text-blue-400',
    glowClass: '',
  },
  {
    title: 'ACTIVE EXECUTIONS',
    key: 'activeExecutions' as const,
    icon: Play,
    borderColor: 'border-emerald-500/60',
    iconColor: 'text-emerald-400',
    glowClass: 'glow-success',
  },
  {
    title: 'QUEUED',
    key: 'queuedExecutions' as const,
    icon: Clock,
    borderColor: 'border-amber-500/60',
    iconColor: 'text-amber-400',
    glowClass: '',
  },
  {
    title: 'FAILED (24H)',
    key: 'failedLast24h' as const,
    icon: AlertTriangle,
    borderColor: 'border-red-500/60',
    iconColor: 'text-red-400',
    glowClass: '',
  },
] as const;

export function StatsGrid({ stats }: StatsGridProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {METRIC_CONFIGS.map((metric) => (
        <Card
          key={metric.title}
          className={cn(
            'border-l-2 hover:scale-[1.01] cursor-default',
            metric.borderColor,
            metric.glowClass,
          )}
        >
          <CardContent className="px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium mb-2">
                  {metric.title}
                </p>
                <p className="text-4xl font-mono font-semibold text-foreground tabular-nums leading-none">
                  {stats[metric.key]}
                </p>
              </div>
              <div className={cn('mt-1 rounded-lg p-2 bg-white/[0.04]', metric.iconColor)}>
                <metric.icon className="h-4 w-4" />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
