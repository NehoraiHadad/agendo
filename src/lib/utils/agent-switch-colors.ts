/**
 * Stable color assignment for agent switch UI components.
 * Separated from component files to satisfy fast-refresh rules.
 */

const AGENT_COLOR_KEYS = ['blue', 'green', 'purple', 'cyan', 'orange', 'pink', 'yellow', 'red'];

/** Derive a stable team-color key from an agent name using a simple hash. */
export function agentColorKey(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  }
  return AGENT_COLOR_KEYS[hash % AGENT_COLOR_KEYS.length];
}

const AGENT_PILL_PALETTE = [
  'bg-blue-500/10 text-blue-300 border-blue-500/20',
  'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
  'bg-violet-500/10 text-violet-300 border-violet-500/20',
  'bg-cyan-500/10 text-cyan-300 border-cyan-500/20',
  'bg-orange-500/10 text-orange-300 border-orange-500/20',
  'bg-pink-500/10 text-pink-300 border-pink-500/20',
];

/** Derive a stable pill class string (bg + text + border) from an agent name. */
export function agentPillClass(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffff;
  }
  return AGENT_PILL_PALETTE[hash % AGENT_PILL_PALETTE.length];
}
