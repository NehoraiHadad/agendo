/**
 * MCP config generators for various AI agents.
 */

export interface SessionIdentity {
  sessionId: string;
  taskId: string | null;
  agentId: string;
  projectId: string | null;
}

/**
 * Generate an MCP config object that includes session identity env vars so the
 * MCP server can associate incoming tool calls with the correct session, task,
 * agent, and project without needing a separate auth mechanism.
 */
export function generateSessionMcpConfig(serverPath: string, identity: SessionIdentity): object {
  const agendoUrl = process.env.AGENDO_URL ?? 'http://localhost:4100';
  return {
    mcpServers: {
      agendo: {
        command: 'node',
        args: [serverPath],
        env: {
          AGENDO_URL: agendoUrl,
          AGENDO_SESSION_ID: identity.sessionId,
          AGENDO_TASK_ID: identity.taskId ?? '',
          AGENDO_AGENT_ID: identity.agentId,
          AGENDO_PROJECT_ID: identity.projectId ?? '',
        },
      },
    },
  };
}

export function generateClaudeMcpConfig(serverPath: string): object {
  return {
    mcpServers: {
      'agendo': {
        command: 'node',
        args: [serverPath],
        env: {
          AGENDO_URL: process.env.AGENDO_URL ?? 'http://localhost:4100',
        },
      },
    },
  };
}

export function generateCodexMcpConfig(serverPath: string): string {
  const url = process.env.AGENDO_URL ?? 'http://localhost:4100';
  return `[mcp_servers.agendo]
command = "node"
args = ["${serverPath}"]

[mcp_servers.agendo.env]
AGENDO_URL = "${url}"
`;
}

export function generateGeminiMcpConfig(serverPath: string): object {
  return {
    mcpServers: {
      'agendo': {
        command: 'node',
        args: [serverPath],
        env: {
          AGENDO_URL: process.env.AGENDO_URL ?? 'http://localhost:4100',
        },
      },
    },
  };
}

/**
 * Generates .mcp.json content for a project root.
 * Used by "agendo init" so any Claude Code session in the project
 * automatically has Agendo tools — even when run manually outside Agendo.
 *
 * In Mode 2 (external agent), no session identity is available,
 * so tools work with explicit IDs passed by the agent.
 */
export function generateProjectMcpJson(serverPath: string, agendoUrl?: string): object {
  const url = agendoUrl ?? process.env.AGENDO_URL ?? 'http://localhost:4100';
  return {
    mcpServers: {
      agendo: {
        command: 'node',
        args: [serverPath],
        env: {
          AGENDO_URL: url,
        },
      },
    },
  };
}

export function generateGeminiRestFallbackInstructions(): string {
  const baseUrl = process.env.AGENDO_URL ?? 'http://localhost:4100';
  return `# agenDo REST API Instructions

When MCP is not available, use these REST endpoints directly.

## List Tasks
\`\`\`bash
curl -s "${baseUrl}/api/tasks?status=todo&limit=50" | jq .
\`\`\`

## Create Task
\`\`\`bash
curl -s -X POST "${baseUrl}/api/tasks" \\
  -H "Content-Type: application/json" \\
  -d '{"title": "My task", "priority": 3}' | jq .
\`\`\`

## Update Task
\`\`\`bash
curl -s -X PATCH "${baseUrl}/api/tasks/{taskId}" \\
  -H "Content-Type: application/json" \\
  -d '{"status": "in_progress"}' | jq .
\`\`\`

## Assign Task
\`\`\`bash
curl -s -X PATCH "${baseUrl}/api/tasks/{taskId}" \\
  -H "Content-Type: application/json" \\
  -d '{"assigneeAgentId": "{agentId}"}' | jq .
\`\`\`

## List Agents
\`\`\`bash
curl -s "${baseUrl}/api/agents" | jq .
\`\`\`

## Get Agent by Slug
\`\`\`bash
curl -s "${baseUrl}/api/agents?slug=claude-code" | jq .
\`\`\`
`;
}
