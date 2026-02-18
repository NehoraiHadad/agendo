import { Clock, Play, XCircle, CheckCircle, AlertTriangle, Ban, Timer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ExecutionStatus } from '@/lib/types';

interface StatusConfig {
  label: string;
  icon: React.ElementType;
  className: string;
}

const STATUS_CONFIG: Record<ExecutionStatus, StatusConfig> = {
  queued: {
    label: 'Queued',
    icon: Clock,
    className: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
  },
  running: {
    label: 'Running',
    icon: Play,
    className: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
  },
  cancelling: {
    label: 'Cancelling',
    icon: XCircle,
    className: 'bg-amber-500/15 text-amber-400 border border-amber-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
  },
  succeeded: {
    label: 'Succeeded',
    icon: CheckCircle,
    className: 'bg-emerald-600/15 text-emerald-300 border border-emerald-600/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
  },
  failed: {
    label: 'Failed',
    icon: AlertTriangle,
    className: 'bg-red-500/15 text-red-400 border border-red-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5 glow-danger',
  },
  cancelled: {
    label: 'Cancelled',
    icon: Ban,
    className: 'bg-zinc-600/15 text-zinc-500 border border-zinc-600/20 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
  },
  timed_out: {
    label: 'Timed Out',
    icon: Timer,
    className: 'bg-orange-500/15 text-orange-400 border border-orange-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
  },
};

interface ExecutionStatusBadgeProps {
  status: ExecutionStatus;
  className?: string;
}

export function ExecutionStatusBadge({ status, className }: ExecutionStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  const showPulseDot = status === 'running' || status === 'cancelling';

  return (
    <Badge className={cn(config.className, className)}>
      {showPulseDot ? (
        <span className={cn(
          'inline-block h-1.5 w-1.5 rounded-full shrink-0',
          status === 'running' ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400 animate-pulse'
        )} />
      ) : (
        <Icon className="size-3 shrink-0" />
      )}
      {config.label}
    </Badge>
  );
}
