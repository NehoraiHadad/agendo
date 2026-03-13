/**
 * Color assignment utilities for brainstorm room participants.
 * Each agent gets a consistent color based on its slug prefix.
 *
 * Also exports shared helpers used across brainstorm components:
 *  - getInitials: avatar initial extraction (avoids duplication)
 *  - BRAINSTORM_STATUS_CONFIG: canonical status badge styling map
 */

import { TEAM_COLORS, DEFAULT_TEAM_COLOR } from './team-colors';
import type { TeamColorSet } from './team-colors';

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Extract 1–2 uppercase initials from an agent display name.
 * "Claude Code" → "CC", "gemini-cli-1" → "GC", "Agent" → "AG"
 */
export function getInitials(name: string): string {
  const words = name.trim().split(/[\s-_]+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// ============================================================================
// Shared status badge configuration
// ============================================================================

export interface BrainstormStatusConfig {
  label: string;
  /** Tailwind classes for the badge container */
  className: string;
  /** Tailwind class for the dot */
  dotClassName: string;
  /** Whether the dot should pulse */
  animated: boolean;
}

export const BRAINSTORM_STATUS_CONFIG: Record<string, BrainstormStatusConfig> = {
  waiting: {
    label: 'Waiting',
    className: 'bg-zinc-500/10 text-zinc-400 border-zinc-600/15',
    dotClassName: 'bg-zinc-500',
    animated: false,
  },
  active: {
    label: 'Active',
    className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    dotClassName: 'bg-emerald-400',
    animated: true,
  },
  paused: {
    label: 'Paused',
    className: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    dotClassName: 'bg-amber-400',
    animated: false,
  },
  synthesizing: {
    label: 'Synthesizing',
    className: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    dotClassName: 'bg-violet-400',
    animated: true,
  },
  ended: {
    label: 'Ended',
    className: 'bg-zinc-500/10 text-zinc-500 border-zinc-600/20',
    dotClassName: 'bg-zinc-500',
    animated: false,
  },
};

/** Maps agent slug prefixes to color names in the TEAM_COLORS palette. */
const AGENT_COLOR_MAP: Record<string, string> = {
  claude: 'purple',
  gemini: 'green',
  codex: 'blue',
  copilot: 'orange',
};

/** Rotation order for agents not matched by the prefix map. */
const COLOR_ROTATION = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red'];

/**
 * Returns a TeamColorSet for an agent based on its slug.
 * Falls back to index-based rotation when the slug is not recognized.
 */
export function getAgentColor(agentSlug: string, index = 0): TeamColorSet {
  const normalized = agentSlug.toLowerCase();
  for (const [prefix, color] of Object.entries(AGENT_COLOR_MAP)) {
    if (normalized.startsWith(prefix)) {
      return TEAM_COLORS[color] ?? DEFAULT_TEAM_COLOR;
    }
  }
  const color = COLOR_ROTATION[index % COLOR_ROTATION.length];
  return TEAM_COLORS[color] ?? DEFAULT_TEAM_COLOR;
}
