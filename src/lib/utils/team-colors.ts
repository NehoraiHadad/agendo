/**
 * Shared team color utilities for agent team UI components.
 * Extracted from session-chat-view.tsx to be reusable across TeamPanel,
 * AgentThreadSheet, and TeamMessageCard.
 */

export interface TeamColorSet {
  /** Left border Tailwind class (e.g. "border-l-blue-400") */
  border: string;
  /** Text color Tailwind class for the ● dot character */
  dot: string;
  /** Very subtle background tint Tailwind class */
  bg: string;
  /** Background color Tailwind class for animated pulse dot */
  pulse: string;
}

/** Maps Claude team color names to Tailwind classes. */
export const TEAM_COLORS: Record<string, TeamColorSet> = {
  blue: {
    border: 'border-l-blue-400',
    dot: 'text-blue-400',
    bg: 'bg-blue-400/[0.04]',
    pulse: 'bg-blue-400',
  },
  green: {
    border: 'border-l-emerald-400',
    dot: 'text-emerald-400',
    bg: 'bg-emerald-400/[0.04]',
    pulse: 'bg-emerald-400',
  },
  purple: {
    border: 'border-l-purple-400',
    dot: 'text-purple-400',
    bg: 'bg-purple-400/[0.04]',
    pulse: 'bg-purple-400',
  },
  red: {
    border: 'border-l-red-400',
    dot: 'text-red-400',
    bg: 'bg-red-400/[0.04]',
    pulse: 'bg-red-400',
  },
  yellow: {
    border: 'border-l-yellow-400',
    dot: 'text-yellow-400',
    bg: 'bg-yellow-400/[0.04]',
    pulse: 'bg-yellow-400',
  },
  orange: {
    border: 'border-l-orange-400',
    dot: 'text-orange-400',
    bg: 'bg-orange-400/[0.04]',
    pulse: 'bg-orange-400',
  },
  cyan: {
    border: 'border-l-cyan-400',
    dot: 'text-cyan-400',
    bg: 'bg-cyan-400/[0.04]',
    pulse: 'bg-cyan-400',
  },
  pink: {
    border: 'border-l-pink-400',
    dot: 'text-pink-400',
    bg: 'bg-pink-400/[0.04]',
    pulse: 'bg-pink-400',
  },
};

export const DEFAULT_TEAM_COLOR: TeamColorSet = {
  border: 'border-l-zinc-500',
  dot: 'text-zinc-400',
  bg: 'bg-zinc-400/[0.04]',
  pulse: 'bg-zinc-400',
};

/** Resolve a color name to its TeamColorSet, falling back to default. */
export function getTeamColor(color: string | undefined): TeamColorSet {
  return TEAM_COLORS[color ?? ''] ?? DEFAULT_TEAM_COLOR;
}
