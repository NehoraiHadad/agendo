/**
 * Agendo Claude Code hook script generators.
 * These produce shell scripts that are written to .claude/settings.local.json
 * in the session's working directory before spawn.
 *
 * NOTE: No @/ imports — this file may be used in non-bundled contexts.
 */

/**
 * Generates the post-tool-use hook script that POSTs activity events to Agendo.
 * The hook fires after Write, Edit, or Bash tool calls.
 */
export function generatePostToolUseHook(agendoUrl: string, sessionId: string): string {
  return `#!/bin/sh
# Agendo post-tool-use hook — fires after Write/Edit/Bash tool calls.
# Claude Code passes hook input via stdin as JSON; extract tool_name with grep.
INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)
TOOL_NAME=\${TOOL_NAME:-unknown}
curl -s -X POST "${agendoUrl}/api/sessions/${sessionId}/events" \\
  -H "Content-Type: application/json" \\
  -d "{\\"type\\":\\"agent:activity\\",\\"thinking\\":false,\\"note\\":\\"used $TOOL_NAME\\"}" \\
  --max-time 2 > /dev/null 2>&1 || true
`;
}

/**
 * Generates the stop hook script that POSTs a session-idle event to Agendo.
 * The hook fires when Claude finishes responding (Stop event).
 */
export function generateStopHook(agendoUrl: string, sessionId: string, taskId: string | null): string {
  const taskNote = taskId ? ` (task: ${taskId})` : '';
  return `#!/bin/sh
# Agendo stop hook — fires when Claude finishes a response
curl -s -X POST "${agendoUrl}/api/sessions/${sessionId}/events" \\
  -H "Content-Type: application/json" \\
  -d "{\\"type\\":\\"agent:activity\\",\\"thinking\\":false,\\"note\\":\\"session idle${taskNote}\\"}" \\
  --max-time 2 > /dev/null 2>&1 || true
`;
}

export interface AgendoHooksConfig {
  hooks: {
    PostToolUse?: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string }>;
    }>;
    Stop?: Array<{
      hooks: Array<{ type: 'command'; command: string }>;
    }>;
  };
}

/**
 * Generates a portable hook script for use in external projects (Mode 2).
 * This script reads AGENDO_TASK_ID from env and POSTs a sync event to Agendo.
 * Written to a file like agendo-sync-task.sh in the project's .claude/ dir.
 */
export function generateExternalHookScript(agendoUrl: string): string {
  // Use string concatenation for the shell variable to prevent TypeScript
  // template literal interpolation of ${CLAUDE_TOOL_NAME:-unknown}.
  return `#!/bin/sh
# Agendo external hook — syncs Claude Code task operations to Agendo board
# Set AGENDO_TASK_ID in env to associate with an Agendo task.
# Claude Code passes hook input via stdin as JSON; extract tool_name with grep.
if [ -z "$AGENDO_TASK_ID" ]; then
  exit 0
fi

INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | grep -o '"tool_name":"[^"]*"' | cut -d'"' -f4)
TOOL_NAME=\${TOOL_NAME:-unknown}
curl -s -X POST "${agendoUrl}/api/tasks/$AGENDO_TASK_ID/events" \\
  -H "Content-Type: application/json" \\
  -d "{\\"eventType\\":\\"agent_note\\",\\"payload\\":{\\"note\\":\\"used $TOOL_NAME\\"}}" \\
  --max-time 2 > /dev/null 2>&1 || true
`;
}

/**
 * Generates the .claude/settings.json content for external project integration.
 * This should be checked into the project repository.
 *
 * Agents running in the project will have hooks that sync tool operations
 * to the Agendo board via AGENDO_TASK_ID env var.
 */
export function generateExternalProjectHooksConfig(agendoUrl: string): object {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit|Bash',
          hooks: [
            {
              type: 'command',
              command: generateExternalHookScript(agendoUrl),
            },
          ],
        },
      ],
    },
  };
}

/**
 * Generates the .claude/settings.local.json content for a session.
 */
export function generateSessionHooksConfig(
  agendoUrl: string,
  sessionId: string,
  taskId: string | null,
): AgendoHooksConfig {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Write|Edit|Bash',
          hooks: [
            {
              type: 'command',
              command: generatePostToolUseHook(agendoUrl, sessionId),
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: generateStopHook(agendoUrl, sessionId, taskId),
            },
          ],
        },
      ],
    },
  };
}
