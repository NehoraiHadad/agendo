import { Suspense } from 'react';
import { getDashboardStats } from '@/lib/services/dashboard-service';
import { StatsGrid } from '@/components/dashboard/stats-grid';
import { RecentTasksFeed } from '@/components/dashboard/recent-tasks-feed';
import { AgentHealthGrid } from '@/components/dashboard/agent-health-grid';
import { ClaudeUsageCard } from '@/components/dashboard/claude-usage-card';
import { SystemResourcesCard } from '@/components/dashboard/system-resources-card';
import { DashboardSkeleton } from '@/components/dashboard/dashboard-skeleton';
import { WelcomeCard } from '@/components/dashboard/welcome-card';

async function DashboardContent() {
  const stats = await getDashboardStats();

  const isEmpty = stats.totalTasks === 0 && stats.recentEvents.length === 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      {isEmpty && <WelcomeCard agentCount={stats.agentHealth.length} />}
      <StatsGrid stats={stats} />
      <ClaudeUsageCard />
      <RecentTasksFeed events={stats.recentEvents} />
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
