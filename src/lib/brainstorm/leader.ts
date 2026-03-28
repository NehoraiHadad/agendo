/**
 * Leader selection for brainstorm rooms.
 *
 * One participant is designated the leader at room creation. The leader:
 * - Synthesizes the final recommendation
 * - Breaks ties on disagreements
 * - Is the primary executor of any resulting actions
 *
 * Priority: Claude > Codex > Gemini > Copilot (configurable).
 */

import type { Provider } from '@/lib/services/model-service';

/** Default leader priority — lower number = higher priority. */
export const LEADER_PRIORITY: Record<Provider, number> = {
  anthropic: 1, // Claude Code — highest priority
  openai: 2, // Codex
  google: 3, // Gemini
  github: 4, // Copilot
};

interface LeaderCandidate {
  id: string;
  agentSlug: string;
  provider: Provider | null;
}

/**
 * Select the leader from a list of participants.
 *
 * @param participants - Array of participant candidates with id, slug, and provider
 * @param explicitLeaderId - If set, this participant is forced as leader (user override)
 * @returns The participant ID of the selected leader
 */
export function selectLeader(
  participants: LeaderCandidate[],
  explicitLeaderId?: string | null,
): string | null {
  if (participants.length === 0) return null;

  // Explicit override takes precedence
  if (explicitLeaderId) {
    const found = participants.find((p) => p.id === explicitLeaderId);
    if (found) return found.id;
  }

  // Sort by provider priority (lowest number first), then by array order for ties
  const sorted = [...participants].sort((a, b) => {
    const aPriority = a.provider ? (LEADER_PRIORITY[a.provider] ?? 99) : 99;
    const bPriority = b.provider ? (LEADER_PRIORITY[b.provider] ?? 99) : 99;
    return aPriority - bPriority;
  });

  return sorted[0].id;
}

/**
 * Build the preamble section for a leader participant.
 */
export function buildLeaderPreambleSection(): string {
  return `## You Are the Leader

You have been designated as the brainstorm leader. This means:
- You will synthesize the final recommendation at the end
- You break ties when participants disagree
- You are the primary executor of any actions that result from this brainstorm
- Other participants may address unresolved disagreements to you

This does NOT mean you have more say during discussion — everyone contributes equally.
Your special role is in decision-making and execution after the discussion concludes.`;
}

/**
 * Build the preamble section for a non-leader participant.
 */
export function buildNonLeaderPreambleSection(leaderName: string): string {
  return `## The Leader

**${leaderName}** is the designated leader for this brainstorm. The leader will:
- Synthesize the final recommendation
- Break ties on disagreements
- Execute any resulting actions

Address unresolved disagreements to the leader. You contribute ideas equally —
the leader's special role is in final decision-making, not in having more say.`;
}
