import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ListTodo, Play, Clock, AlertTriangle } from 'lucide-react';
import type { DashboardStats } from '@/lib/services/dashboard-service';

interface StatsGridProps {
  stats: DashboardStats;
}

export function StatsGrid({ stats }: StatsGridProps) {
  const cards = [
    { title: 'Total Tasks', value: stats.totalTasks, icon: ListTodo, color: 'text-blue-500' },
    {
      title: 'Active Executions',
      value: stats.activeExecutions,
      icon: Play,
      color: 'text-green-500',
    },
    { title: 'Queued', value: stats.queuedExecutions, icon: Clock, color: 'text-amber-500' },
    {
      title: 'Failed (24h)',
      value: stats.failedLast24h,
      icon: AlertTriangle,
      color: 'text-red-500',
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className={`h-4 w-4 ${card.color}`} />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{card.value}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
