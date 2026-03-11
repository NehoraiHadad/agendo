/**
 * MCP config generators for various AI agents.
 */

import type { AcpMcpServer } from '@/lib/worker/adapters/types';

export interface SessionIdentity {
  sessionId: string;
  taskId: string | null;
  agentId: string;
  projectId: string | null;
}

/**
 * A resolved MCP server ready to be injected into an agent session.
 * Produced by mcp-server-service.resolveSessionMcpServers().
 */
export interface ResolvedMcpServer {
  name: string;
  transportType: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  url?: string | null;
  headers?: Record<string, string>;
}

/**
 * Convert a ResolvedMcpServer to Claude's MCP config format.
 * Returns null for incompatible transport types (http not yet supported by all callers).
 */
function toClaudeFormat(server: ResolvedMcpServer): Record<string, unknown> | null {
  if (server.transportType === 'stdio') {
    if (!server.command) return null;
    return {
      command: server.command,
      args: server.args ?? [],
      ...(server.env ? { env: server.env } : {}),
    };
  }
  if (server.transportType === 'http') {
    if (!server.url) return null;
    return {
      type: 'http',
      url: server.url,
      ...(server.headers ? { headers: server.headers } : {}),
    };
  }
  return null;
}

/**
 * Convert a ResolvedMcpServer to ACP format (for Gemini/Codex).
 * Only stdio servers are supported — returns null for http servers.
 */
export function toAcpFormat(server: ResolvedMcpServer): AcpMcpServer | null {
  if (server.transportType !== 'stdio') return null;
  if (!server.command) return null;
  return {
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
  };
}

/**
 * Generate an MCP config object that includes session identity env vars so the
 * MCP server can associate incoming tool calls with the correct session, task,
 * agent, and project without needing a separate auth mechanism.
 */
export function generateSessionMcpConfig(
  serverPath: string,
  identity: SessionIdentity,
  additionalServers: ResolvedMcpServer[] = [],
): object {
  const agendoUrl = process.env.AGENDO_URL ?? 'http://localhost:4100';

  const mcpServers: Record<string, unknown> = {
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
  };

  for (const server of additionalServers) {
    const formatted = toClaudeFormat(server);
    if (formatted) {
      mcpServers[server.name] = formatted;
    }
  }

  return { mcpServers };
}

/**
 * Generate SDK-format MCP servers for the Claude Agent SDK.
 * Returns a Record compatible with SDK Options.mcpServers (no temp file needed).
 * This replaces the temp JSON file approach used with --mcp-config.
 */
export function generateSdkSessionMcpServers(
  serverPath: string,
  identity: SessionIdentity,
  additionalServers: ResolvedMcpServer[] = [],
): Record<string, { command: string; args?: string[]; env?: Record<string, string> }> {
  const agendoUrl = process.env.AGENDO_URL ?? 'http://localhost:4100';

  const servers: Record<
    string,
    { command: string; args?: string[]; env?: Record<string, string> }
  > = {
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
  };

  for (const server of additionalServers) {
    if (server.transportType === 'stdio' && server.command) {
      servers[server.name] = {
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
      };
    }
    // Skip HTTP servers — SDK stdio-only for now
  }

  return servers;
}

export function generateClaudeMcpConfig(serverPath: string): object {
  return {
    mcpServers: {
      agendo: {
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

/**
 * Generate the ACP mcpServers array for a Gemini session/new request.
 * Embeds session identity so the MCP server can associate tool calls with
 * the correct session without a separate auth mechanism.
 *
 * Note: HTTP servers are skipped — Gemini ACP only supports stdio transport.
 */
export function generateGeminiAcpMcpServers(
  serverPath: string,
  identity: SessionIdentity,
  additionalServers: ResolvedMcpServer[] = [],
): AcpMcpServer[] {
  // Gemini ACP envVariableSchema: array of {name, value} — NOT a dict.
  const servers: AcpMcpServer[] = [
    {
      name: 'agendo',
      command: 'node',
      args: [serverPath],
      env: [
        { name: 'AGENDO_URL', value: process.env.AGENDO_URL ?? 'http://localhost:4100' },
        { name: 'AGENDO_SESSION_ID', value: identity.sessionId },
        { name: 'AGENDO_TASK_ID', value: identity.taskId ?? '' },
        { name: 'AGENDO_AGENT_ID', value: identity.agentId },
        { name: 'AGENDO_PROJECT_ID', value: identity.projectId ?? '' },
      ],
    },
  ];

  for (const server of additionalServers) {
    const formatted = toAcpFormat(server);
    if (formatted) {
      servers.push(formatted);
    }
  }

  return servers;
}

export function generateGeminiMcpConfig(serverPath: string): object {
  return {
    mcpServers: {
      agendo: {
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
