'use client';

import { cn } from '@/lib/utils';
import type { PlanStatus } from '@/lib/types';

interface StatusConfig {
  label: string;
  dotColor: string;
  pillBg: string;
  pillBorder: string;
  textColor: string;
  pulse: boolean;
}

const PLAN_STATUS_CONFIG: Record<PlanStatus, StatusConfig> = {
  draft: {
    label: 'Draft',
    dotColor: 'bg-zinc-400',
    pillBg: 'bg-zinc-500/10',
    pillBorder: 'border-zinc-500/20',
    textColor: 'text-zinc-400',
    pulse: false,
  },
  ready: {
    label: 'Ready',
    dotColor: 'bg-blue-400',
    pillBg: 'bg-blue-500/10',
    pillBorder: 'border-blue-500/25',
    textColor: 'text-blue-400',
    pulse: false,
  },
  stale: {
    label: 'Stale',
    dotColor: 'bg-amber-400',
    pillBg: 'bg-amber-500/10',
    pillBorder: 'border-amber-500/25',
    textColor: 'text-amber-400',
    pulse: false,
  },
  executing: {
    label: 'Executing',
    dotColor: 'bg-violet-400',
    pillBg: 'bg-violet-500/10',
    pillBorder: 'border-violet-500/25',
    textColor: 'text-violet-400',
    pulse: true,
  },
  done: {
    label: 'Done',
    dotColor: 'bg-emerald-400',
    pillBg: 'bg-emerald-500/10',
    pillBorder: 'border-emerald-500/25',
    textColor: 'text-emerald-400',
    pulse: false,
  },
  archived: {
    label: 'Archived',
    dotColor: 'bg-zinc-600',
    pillBg: 'bg-zinc-700/10',
    pillBorder: 'border-zinc-700/20',
    textColor: 'text-zinc-500',
    pulse: false,
  },
};

interface PlanStatusBadgeProps {
  status: PlanStatus;
  className?: string;
}

export function PlanStatusBadge({ status, className }: PlanStatusBadgeProps) {
  const cfg = PLAN_STATUS_CONFIG[status];

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2.5 py-1 border',
        cfg.pillBg,
        cfg.pillBorder,
        cfg.textColor,
        className,
      )}
    >
      <span
        className={cn('inline-block size-1.5 rounded-full shrink-0', cfg.dotColor, {
          'animate-pulse': cfg.pulse,
        })}
      />
      {cfg.label}
    </span>
  );
}
