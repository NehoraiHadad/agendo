import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface AgentStatusBadgeProps {
  isActive: boolean;
  status?: 'active' | 'inactive' | 'busy' | 'idle';
  className?: string;
}

export function AgentStatusBadge({ isActive, status, className }: AgentStatusBadgeProps) {
  if (status === 'busy') {
    return (
      <Badge className={cn('bg-amber-500/15 text-amber-400 border border-amber-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5', className)}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
        Busy
      </Badge>
    );
  }
  if (status === 'idle' || (!isActive && !status)) {
    return (
      <Badge className={cn('bg-zinc-500/15 text-zinc-400 border border-zinc-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5', className)}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-500 shrink-0" />
        Idle
      </Badge>
    );
  }
  if (isActive || status === 'active') {
    return (
      <Badge className={cn('bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5', className)}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
        Active
      </Badge>
    );
  }
  return (
    <Badge className={cn('bg-zinc-600/15 text-zinc-500 border border-zinc-600/20 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5', className)}>
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-600 shrink-0" />
      Inactive
    </Badge>
  );
}
