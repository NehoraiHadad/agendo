import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AgentHealthEntry, DashboardStats } from '@/lib/services/dashboard-service';

interface AgentHealthGridProps {
  agents: AgentHealthEntry[];
  workerStatus: DashboardStats['workerStatus'];
}

function getAgentStatus(agent: AgentHealthEntry): { label: string; className: string; dotColor: string } {
  if (!agent.isActive) return { label: 'Disabled', className: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/25', dotColor: 'bg-zinc-500' };
  if (agent.runningExecutions >= agent.maxConcurrent) return { label: 'Busy', className: 'bg-amber-500/15 text-amber-400 border border-amber-500/25', dotColor: 'bg-amber-400 animate-pulse' };
  if (agent.runningExecutions > 0) return { label: 'Active', className: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30', dotColor: 'bg-emerald-400 animate-pulse' };
  return { label: 'Idle', className: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/25', dotColor: 'bg-zinc-500' };
}

export function AgentHealthGrid({ agents, workerStatus }: AgentHealthGridProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Agent Health</h2>
        {workerStatus && (
          <Badge
            className={workerStatus.isOnline
              ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5'
              : 'bg-red-500/15 text-red-400 border border-red-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5 glow-danger'
            }
          >
            {workerStatus.isOnline && <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />}
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
                <Badge className={cn(status.className, 'text-xs px-2.5 py-1 rounded-full font-medium gap-1.5')}>
                  <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', status.dotColor)} />
                  {status.label}
                </Badge>
              </CardHeader>
              <CardContent>
                <p className="text-xs font-mono text-muted-foreground/70">
                  {agent.runningExecutions} / {agent.maxConcurrent} slots
                </p>
              </CardContent>
            </Card>
          );
        })}
        {agents.length === 0 && (
          <p className="col-span-full text-sm text-muted-foreground/60 text-center py-8">No agents registered</p>
        )}
      </div>
    </div>
  );
}
