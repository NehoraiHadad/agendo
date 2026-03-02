import { cn } from '@/lib/utils';
import type { AgentHealthEntry, DashboardStats } from '@/lib/services/dashboard-service';

interface AgentHealthGridProps {
  agents: AgentHealthEntry[];
  workerStatus: DashboardStats['workerStatus'];
}

type AgentStatusInfo = {
  label: string;
  dotClass: string;
  labelClass: string;
};

function getAgentStatus(agent: AgentHealthEntry): AgentStatusInfo {
  if (!agent.isActive)
    return {
      label: 'Disabled',
      dotClass: 'bg-zinc-600',
      labelClass: 'text-zinc-500',
    };
  return {
    label: 'Enabled',
    dotClass: 'bg-emerald-400',
    labelClass: 'text-emerald-400',
  };
}

function AgentRow({ agent }: { agent: AgentHealthEntry }) {
  const status = getAgentStatus(agent);

  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-2.5 rounded-lg hover:bg-white/[0.03] transition-colors border-b border-white/[0.04] last:border-0">
      {/* Name + status dot */}
      <div className="flex items-center gap-2 min-w-0">
        <span className={cn('size-1.5 rounded-full shrink-0', status.dotClass)} />
        <span className="truncate text-sm font-medium text-foreground/90">{agent.name}</span>
      </div>

      {/* Status label */}
      <span className={cn('text-[10px] font-medium w-14 text-right', status.labelClass)}>
        {status.label}
      </span>
    </div>
  );
}

export function AgentHealthGrid({ agents, workerStatus }: AgentHealthGridProps) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[oklch(0.10_0_0)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.05]">
        <h2 className="text-[9px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/40">
          Agent Health
        </h2>
        {workerStatus && (
          <div
            className={cn(
              'flex items-center gap-1.5 text-[10px] font-medium',
              workerStatus.isOnline ? 'text-emerald-400' : 'text-red-400',
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                workerStatus.isOnline ? 'bg-emerald-400 animate-pulse' : 'bg-red-400',
              )}
            />
            Worker {workerStatus.isOnline ? 'Online' : 'Offline'}
          </div>
        )}
      </div>

      {/* Agent rows */}
      <div className="p-2">
        {agents.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground/40">No agents registered</p>
        ) : (
          agents.map((agent) => <AgentRow key={agent.id} agent={agent} />)
        )}
      </div>
    </div>
  );
}
