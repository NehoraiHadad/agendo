import { Activity, MessageSquare, MinusCircle, Pause, type LucideIcon } from 'lucide-react';
import type { SessionStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// Canonical session status config used across all UI components.
// Standardized label: "Your Turn" (not "Your turn" or "Awaiting input").
// ---------------------------------------------------------------------------

export interface SessionStatusConfig {
  /** Short human-readable label */
  label: string;
  /** Lucide icon component */
  icon: LucideIcon;
  /** Full Tailwind badge class string (background + text + border) */
  badgeClassName: string;
  /** Whether the status indicator should pulse */
  pulse: boolean;
  /** Text color class (e.g. "text-blue-400") */
  textColor: string;
  /** Dot fill class for circle indicators (e.g. "fill-blue-400") */
  dotFill: string;
  /** Dot background class for inline dot indicators */
  dotBg: string;
  /** Pill background class */
  pillBg: string;
  /** Pill border class */
  pillBorder: string;
}

export const SESSION_STATUS_CONFIG: Record<SessionStatus, SessionStatusConfig> = {
  active: {
    label: 'Active',
    icon: Activity,
    badgeClassName:
      'bg-blue-500/15 text-blue-400 border border-blue-500/30 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
    pulse: true,
    textColor: 'text-blue-400',
    dotFill: 'fill-blue-400',
    dotBg: 'bg-blue-400',
    pillBg: 'bg-blue-500/10',
    pillBorder: 'border-blue-500/25',
  },
  awaiting_input: {
    label: 'Your Turn',
    icon: MessageSquare,
    badgeClassName:
      'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
    pulse: true,
    textColor: 'text-emerald-400',
    dotFill: 'fill-emerald-400',
    dotBg: 'bg-emerald-400',
    pillBg: 'bg-emerald-500/10',
    pillBorder: 'border-emerald-500/25',
  },
  idle: {
    label: 'Paused',
    icon: Pause,
    badgeClassName:
      'bg-zinc-500/15 text-zinc-400 border border-zinc-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
    pulse: false,
    textColor: 'text-zinc-400',
    dotFill: 'fill-zinc-500',
    dotBg: 'bg-zinc-500',
    pillBg: 'bg-zinc-500/10',
    pillBorder: 'border-zinc-600/20',
  },
  ended: {
    label: 'Ended',
    icon: MinusCircle,
    badgeClassName:
      'bg-zinc-600/15 text-zinc-500 border border-zinc-600/20 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
    pulse: false,
    textColor: 'text-zinc-500',
    dotFill: 'fill-zinc-600',
    dotBg: 'bg-zinc-600',
    pillBg: 'bg-zinc-700/10',
    pillBorder: 'border-zinc-700/20',
  },
};
