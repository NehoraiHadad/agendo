/**
 * Color assignment utilities for brainstorm room participants.
 * Each agent gets a consistent color based on its slug prefix.
 */

import { TEAM_COLORS, DEFAULT_TEAM_COLOR } from './team-colors';
import type { TeamColorSet } from './team-colors';

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
