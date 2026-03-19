'use client';

import { cn } from '@/lib/utils';

export interface StatusConfig {
  label: string;
  dotColor: string;
  pillBg: string;
  pillBorder: string;
  textColor: string;
  pulse?: boolean;
}

interface StatusBadgeProps {
  config: StatusConfig;
  className?: string;
}

export function StatusBadge({ config, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full px-2.5 py-1 border',
        config.pillBg,
        config.pillBorder,
        config.textColor,
        className,
      )}
    >
      <span
        className={cn('inline-block size-1.5 rounded-full shrink-0', config.dotColor, {
          'animate-pulse': config.pulse,
        })}
      />
      {config.label}
    </span>
  );
}
