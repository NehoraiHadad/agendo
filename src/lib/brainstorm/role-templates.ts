/**
 * Brainstorm Role Templates
 *
 * Default role instructions for brainstorm participants and auto-assignment
 * rules based on participant count.
 */

/**
 * Default per-role instructions injected into each participant's preamble.
 * Keys are role labels (lowercase) matching what's set in BrainstormConfig.roles.
 */
export const DEFAULT_ROLE_INSTRUCTIONS: Record<string, string> = {
  critic: `Your role is CRITIC. Your job is to:
- Challenge assumptions others make without evidence
- Find edge cases and failure modes
- Identify scalability and maintenance risks
- Ask "what happens when..." questions
- Push back on scope creep and over-engineering
Be constructive but relentless in finding weaknesses.`,

  optimist: `Your role is OPTIMIST. Your job is to:
- Find the potential and strengths in each idea
- Identify opportunities others might miss
- Suggest creative extensions and improvements
- Look for synergies between different proposals
Stay grounded in reality but advocate for ambitious approaches.`,

  pragmatist: `Your role is PRAGMATIST. Your job is to:
- Focus on implementation feasibility and effort estimation
- Identify existing code/patterns that can be reused
- Propose the simplest solution that satisfies the requirements
- Call out when discussion is too theoretical
Ground every point in specific files, functions, and timelines.`,

  architect: `Your role is ARCHITECT. Your job is to:
- Think about system-level implications
- Consider how changes affect other components
- Evaluate long-term maintainability
- Propose clean interfaces and boundaries
Reference actual architecture patterns used in the codebase.`,
};

/**
 * Auto-assignment of roles based on participant count when no explicit roles
 * are configured. Maps participant count → ordered list of roles to assign.
 * The i-th role is assigned to the i-th active participant.
 */
export const AUTO_ROLE_ASSIGNMENTS: Record<number, string[]> = {
  2: ['critic', 'pragmatist'],
  3: ['critic', 'optimist', 'pragmatist'],
  4: ['critic', 'optimist', 'pragmatist', 'architect'],
};
