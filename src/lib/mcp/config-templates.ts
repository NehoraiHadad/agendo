/**
 * MCP config generators for various AI agents.
 */

export function generateClaudeMcpConfig(serverPath: string): object {
  return {
    mcpServers: {
      'agent-monitor': {
        command: 'node',
        args: [serverPath],
        env: {
          AGENT_MONITOR_URL: process.env.AGENT_MONITOR_URL ?? 'http://localhost:4100',
        },
      },
    },
  };
}

export function generateCodexMcpConfig(serverPath: string): string {
  const url = process.env.AGENT_MONITOR_URL ?? 'http://localhost:4100';
  return `[mcp_servers.agent-monitor]
command = "node"
args = ["${serverPath}"]

[mcp_servers.agent-monitor.env]
AGENT_MONITOR_URL = "${url}"
`;
}

export function generateGeminiMcpConfig(serverPath: string): object {
  return {
    mcpServers: {
      'agent-monitor': {
        command: 'node',
        args: [serverPath],
        env: {
          AGENT_MONITOR_URL: process.env.AGENT_MONITOR_URL ?? 'http://localhost:4100',
        },
      },
    },
  };
}

export function generateGeminiRestFallbackInstructions(): string {
  const baseUrl = process.env.AGENT_MONITOR_URL ?? 'http://localhost:4100';
  return `# Agent Monitor REST API Instructions

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
