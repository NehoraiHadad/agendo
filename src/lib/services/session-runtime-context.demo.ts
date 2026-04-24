/**
 * Demo-mode shadow for session-runtime-context.
 *
 * Returns a minimal but valid SessionRuntimeContext using canonical demo
 * fixtures. This is worker-only plumbing that is never triggered from the
 * UI in demo mode — the shadow prevents crashes if transitively invoked.
 */

import type { SessionRuntimeContext } from './session-runtime-context';
import { DEMO_AGENT_CLAUDE } from './agent-service.demo';
import { DEMO_SESSION_CLAUDE_EXPLORE } from './session-service.demo';
import { DEMO_PROJECT_AGENDO } from './project-service.demo';

export async function resolveSessionRuntimeContext(
  _sessionId: string,
): Promise<SessionRuntimeContext> {
  return {
    session: DEMO_SESSION_CLAUDE_EXPLORE,
    agent: DEMO_AGENT_CLAUDE,
    task: null,
    project: DEMO_PROJECT_AGENDO,
    resolvedProjectId: DEMO_PROJECT_AGENDO.id,
    cwd: DEMO_PROJECT_AGENDO.rootPath,
    envOverrides: {
      AGENDO_PROJECT_ID: DEMO_PROJECT_AGENDO.id,
    },
  };
}
