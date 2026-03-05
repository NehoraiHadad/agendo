/**
 * Build a sanitized child process environment for agent subprocesses.
 * Strips CLAUDECODE/CLAUDE_CODE_ENTRYPOINT, applies overrides, injects session identity.
 */

export interface SessionIdentity {
  sessionId: string;
  agentId: string;
  taskId: string | null;
}

export function buildChildEnv(
  baseEnv: Record<string, string | undefined>,
  identity: SessionIdentity,
  envOverrides?: Record<string, string>,
): Record<string, string> {
  // Strip CLAUDECODE (nested-session guard) and CLAUDE_CODE_ENTRYPOINT.
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && key !== 'CLAUDECODE' && key !== 'CLAUDE_CODE_ENTRYPOINT') {
      childEnv[key] = value;
    }
  }
  // Apply project/task env overrides on top of the base env.
  if (envOverrides) {
    for (const [k, v] of Object.entries(envOverrides)) {
      childEnv[k] = v;
    }
  }

  // Enable lazy MCP schema loading — reduces initial context window usage by 32K+
  // tokens by deferring MCP tool schema injection until tools are actually needed.
  childEnv['ENABLE_EXPERIMENTAL_MCP_CLI'] = 'true';

  // Session identity vars — available to hooks and sub-processes via env.
  childEnv['AGENDO_SESSION_ID'] = identity.sessionId;
  childEnv['AGENDO_AGENT_ID'] = identity.agentId;
  if (identity.taskId) {
    childEnv['AGENDO_TASK_ID'] = identity.taskId;
  }

  return childEnv;
}
