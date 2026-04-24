import type { ReplayableEvent } from '@/lib/demo/sse/factories';

export { claudeExploreEvents } from './claude-explore';
export { codexRefactorEvents } from './codex-refactor';
export { geminiPlanEvents } from './gemini-plan';

import { claudeExploreEvents } from './claude-explore';
import { codexRefactorEvents } from './codex-refactor';
import { geminiPlanEvents } from './gemini-plan';

export const DEMO_SESSION_EVENTS: Record<string, ReplayableEvent[]> = {
  '77777777-7777-4777-a777-777777777777': claudeExploreEvents,
  '88888888-8888-4888-a888-888888888888': codexRefactorEvents,
  '99999999-9999-4999-a999-999999999999': geminiPlanEvents,
};
