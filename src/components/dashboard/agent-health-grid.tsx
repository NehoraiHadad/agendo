import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { AgentHealthEntry, DashboardStats } from '@/lib/services/dashboard-service';

interface AgentHealthGridProps {
  agents: AgentHealthEntry[];
  workerStatus: DashboardStats['workerStatus'];
}

function getAgentStatus(agent: AgentHealthEntry): { label: string; className: string } {
  if (!agent.isActive) return { label: 'Disabled', className: 'bg-zinc-500 text-zinc-100' };
  if (agent.runningExecutions >= agent.maxConcurrent)
    return { label: 'Busy', className: 'bg-amber-500 text-amber-100' };
  if (agent.runningExecutions > 0)
    return { label: 'Active', className: 'bg-green-500 text-green-100' };
  return { label: 'Idle', className: 'bg-zinc-400 text-zinc-100' };
}

export function AgentHealthGrid({ agents, workerStatus }: AgentHealthGridProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Agent Health</h2>
        {workerStatus && (
          <Badge
            className={
              workerStatus.isOnline ? 'bg-green-600 text-green-100' : 'bg-red-600 text-red-100'
            }
          >
            Worker {workerStatus.isOnline ? 'Online' : 'Offline'}
          </Badge>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((agent) => {
          const status = getAgentStatus(agent);
          return (
            <Card key={agent.id}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{agent.name}</CardTitle>
                <Badge className={status.className}>{status.label}</Badge>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">
                  {agent.runningExecutions} / {agent.maxConcurrent} slots
                </p>
              </CardContent>
            </Card>
          );
        })}
        {agents.length === 0 && (
          <p className="col-span-full text-sm text-muted-foreground">No agents registered</p>
        )}
      </div>
    </div>
  );
}
