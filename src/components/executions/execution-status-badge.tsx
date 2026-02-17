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
    className: 'bg-zinc-600 text-zinc-100',
  },
  running: {
    label: 'Running',
    icon: Play,
    className: 'bg-green-600 text-green-100 animate-pulse',
  },
  cancelling: {
    label: 'Cancelling',
    icon: XCircle,
    className: 'bg-amber-600 text-amber-100 animate-pulse',
  },
  succeeded: {
    label: 'Succeeded',
    icon: CheckCircle,
    className: 'bg-emerald-600 text-emerald-100',
  },
  failed: {
    label: 'Failed',
    icon: AlertTriangle,
    className: 'bg-red-600 text-red-100',
  },
  cancelled: {
    label: 'Cancelled',
    icon: Ban,
    className: 'bg-zinc-500 text-zinc-200',
  },
  timed_out: {
    label: 'Timed Out',
    icon: Timer,
    className: 'bg-orange-600 text-orange-100',
  },
};

interface ExecutionStatusBadgeProps {
  status: ExecutionStatus;
  className?: string;
}

export function ExecutionStatusBadge({ status, className }: ExecutionStatusBadgeProps) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <Badge className={cn(config.className, className)}>
      <Icon className="size-3" />
      {config.label}
    </Badge>
  );
}
