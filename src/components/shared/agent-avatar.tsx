'use client';

import { getAgentColor, getInitials } from '@/lib/utils/brainstorm-colors';

const SIZE_CLASSES = {
  xs: 'size-5 text-[8px]',
  sm: 'size-6 text-[9px]',
  md: 'size-7 text-[10px]',
  lg: 'size-9 text-xs',
} as const;

interface AgentAvatarProps {
  name: string;
  slug: string;
  index?: number;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
  /** When true, apply the agent's pulse animation class */
  pulse?: boolean;
}

export function AgentAvatar({
  name,
  slug,
  index = 0,
  size = 'md',
  className = '',
  pulse = false,
}: AgentAvatarProps) {
  const colors = getAgentColor(slug, index);
  const initials = getInitials(name);
  const sizeClass = SIZE_CLASSES[size];
  const borderClass = colors.border.replace('border-l-', 'border-');

  return (
    <div
      className={`shrink-0 rounded-full flex items-center justify-center font-bold border ${borderClass} bg-white/[0.03] ${sizeClass} ${pulse ? colors.pulse : ''} ${className}`}
      aria-label={name}
    >
      <span className={colors.dot}>{initials}</span>
    </div>
  );
}
