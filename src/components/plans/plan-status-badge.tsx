'use client';

import { StatusBadge, type StatusConfig } from '@/components/shared/status-badge';
import type { PlanStatus } from '@/lib/types';

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
  return <StatusBadge config={PLAN_STATUS_CONFIG[status]} className={className} />;
}
