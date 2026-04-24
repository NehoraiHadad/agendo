/**
 * Barrel for terminal replay fixtures.
 *
 * TerminalFrame type is defined in @/lib/demo/terminal-scheduler and
 * re-exported here for convenience.
 */

import type { TerminalFrame } from '@/lib/demo/terminal-scheduler';

export type { TerminalFrame };

export { claudeExploreFrames } from './claude-explore';
export { codexRefactorFrames } from './codex-refactor';
export { geminiPlanFrames } from './gemini-plan';

import { claudeExploreFrames } from './claude-explore';
import { codexRefactorFrames } from './codex-refactor';
import { geminiPlanFrames } from './gemini-plan';

/**
 * Map of demo session ID → frames array.
 * Keyed by the canonical demo session UUIDs defined in
 * src/lib/demo/fixtures/sessions/index.ts.
 */
export const DEMO_TERMINAL_FRAMES: Record<string, TerminalFrame[]> = {
  '77777777-7777-4777-a777-777777777777': claudeExploreFrames,
  '88888888-8888-4888-a888-888888888888': codexRefactorFrames,
  '99999999-9999-4999-a999-999999999999': geminiPlanFrames,
};
