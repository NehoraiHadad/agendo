import { Suspense } from 'react';
import { getDashboardStats, getActiveExecutionsList } from '@/lib/services/dashboard-service';
import { StatsGrid } from '@/components/dashboard/stats-grid';
import { ActiveExecutionsList } from '@/components/dashboard/active-executions-list';
import { RecentTasksFeed } from '@/components/dashboard/recent-tasks-feed';
import { AgentHealthGrid } from '@/components/dashboard/agent-health-grid';
import { ClaudeUsageCard } from '@/components/dashboard/claude-usage-card';
import { SystemResourcesCard } from '@/components/dashboard/system-resources-card';
import { DashboardSkeleton } from '@/components/dashboard/dashboard-skeleton';

async function DashboardContent() {
  const [stats, activeExecs] = await Promise.all([getDashboardStats(), getActiveExecutionsList()]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <StatsGrid stats={stats} />
      <ClaudeUsageCard />
      <div className="grid gap-6 lg:grid-cols-2">
        <ActiveExecutionsList initialData={activeExecs} />
        <RecentTasksFeed events={stats.recentEvents} />
      </div>
      <AgentHealthGrid agents={stats.agentHealth} workerStatus={stats.workerStatus} />
      <SystemResourcesCard />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}
