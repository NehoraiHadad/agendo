/**
 * Demo-mode shadow for mcp-server-service.
 *
 * Provides three believable MCP server fixtures with realistic names/descriptions
 * so the agent config page renders meaningful data if it accesses MCP servers.
 * Mutations are no-ops returning stub rows. The project override functions are
 * no-ops since there is no DB to persist to.
 */

import type { McpServer, NewMcpServer, ProjectMcpServer } from '@/lib/types';
import type { ResolvedMcpServer } from './mcp-server-service';

// ---------------------------------------------------------------------------
// Fixed timestamps — deterministic across renders
// ---------------------------------------------------------------------------

const T_7D_AGO = new Date('2026-04-16T10:00:00.000Z');
const T_6D_AGO = new Date('2026-04-17T10:00:00.000Z');
const T_5D_AGO = new Date('2026-04-18T10:00:00.000Z');

// ---------------------------------------------------------------------------
// Fixture MCP server UUIDs
// ---------------------------------------------------------------------------

const AGENDO_MCP_ID = 'aaa00001-0000-4000-a000-000000000001';
const FILESYSTEM_MCP_ID = 'aaa00002-0000-4000-a000-000000000002';
const GITHUB_MCP_ID = 'aaa00003-0000-4000-a000-000000000003';

// ---------------------------------------------------------------------------
// Fixtures — must satisfy McpServer ($inferSelect from mcp_servers)
// ---------------------------------------------------------------------------

export const DEMO_MCP_AGENDO: McpServer = {
  id: AGENDO_MCP_ID,
  name: 'agendo-task-mcp',
  description: 'Agendo task management — create tasks, update status, add progress notes',
  transportType: 'stdio',
  command: 'node',
  args: ['/home/ubuntu/projects/agendo/dist/mcp-server.js'],
  env: {},
  url: null,
  headers: {},
  enabled: true,
  isDefault: true,
  createdAt: T_7D_AGO,
  updatedAt: T_7D_AGO,
};

export const DEMO_MCP_FILESYSTEM: McpServer = {
  id: FILESYSTEM_MCP_ID,
  name: 'filesystem-mcp',
  description: 'Filesystem access — read, write, and search files within allowed directories',
  transportType: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/ubuntu/projects'],
  env: {},
  url: null,
  headers: {},
  enabled: true,
  isDefault: false,
  createdAt: T_6D_AGO,
  updatedAt: T_6D_AGO,
};

export const DEMO_MCP_GITHUB: McpServer = {
  id: GITHUB_MCP_ID,
  name: 'github-mcp',
  description: 'GitHub integration — manage issues, PRs, and repositories via GitHub API',
  transportType: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-github'],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: '***' },
  url: null,
  headers: {},
  enabled: true,
  isDefault: false,
  createdAt: T_5D_AGO,
  updatedAt: T_5D_AGO,
};

export const ALL_DEMO_MCP_SERVERS: McpServer[] = [
  DEMO_MCP_AGENDO,
  DEMO_MCP_FILESYSTEM,
  DEMO_MCP_GITHUB,
];

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function listMcpServers(filters?: { enabled?: boolean }): Promise<McpServer[]> {
  if (filters?.enabled !== undefined) {
    return ALL_DEMO_MCP_SERVERS.filter((s) => s.enabled === filters.enabled);
  }
  return ALL_DEMO_MCP_SERVERS;
}

export async function getMcpServer(id: string): Promise<McpServer | null> {
  return ALL_DEMO_MCP_SERVERS.find((s) => s.id === id) ?? null;
}

export async function getMcpServerByName(name: string): Promise<McpServer | null> {
  return ALL_DEMO_MCP_SERVERS.find((s) => s.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Mutation stubs — no side effects
// ---------------------------------------------------------------------------

export async function createMcpServer(data: NewMcpServer): Promise<McpServer> {
  const now = new Date();
  return {
    id: 'demo-mcp-stub-' + Date.now(),
    name: data.name,
    description: data.description ?? null,
    transportType: data.transportType ?? 'stdio',
    command: data.command ?? null,
    args: data.args ?? [],
    env: data.env ?? {},
    url: data.url ?? null,
    headers: data.headers ?? {},
    enabled: data.enabled ?? true,
    isDefault: data.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateMcpServer(id: string, data: Partial<McpServer>): Promise<McpServer> {
  const existing = ALL_DEMO_MCP_SERVERS.find((s) => s.id === id) ?? DEMO_MCP_AGENDO;
  return { ...existing, ...data, id, updatedAt: new Date() };
}

export async function deleteMcpServer(_id: string): Promise<void> {
  // No-op in demo mode.
}

// ---------------------------------------------------------------------------
// Project override stubs
// ---------------------------------------------------------------------------

export async function getProjectMcpServers(
  _projectId: string,
): Promise<(ProjectMcpServer & { mcpServer: McpServer })[]> {
  return [];
}

export async function setProjectMcpOverride(
  _projectId: string,
  _mcpServerId: string,
  _config: { enabled: boolean; envOverrides?: Record<string, string> },
): Promise<void> {
  // No-op in demo mode.
}

export async function removeProjectMcpOverride(
  _projectId: string,
  _mcpServerId: string,
): Promise<void> {
  // No-op in demo mode.
}

// ---------------------------------------------------------------------------
// Resolve functions — return fixture defaults
// ---------------------------------------------------------------------------

function serverToResolved(server: McpServer): ResolvedMcpServer {
  return {
    name: server.name,
    transportType: server.transportType,
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
    url: server.url,
    headers: server.headers ?? {},
  };
}

export async function resolveSessionMcpServers(
  _projectId: string | null,
): Promise<ResolvedMcpServer[]> {
  // In demo mode return the default server (agendo-task-mcp).
  return ALL_DEMO_MCP_SERVERS.filter((s) => s.isDefault).map(serverToResolved);
}

export async function resolveByMcpServerIds(ids: string[]): Promise<ResolvedMcpServer[]> {
  if (ids.length === 0) return [];
  return ALL_DEMO_MCP_SERVERS.filter((s) => ids.includes(s.id)).map(serverToResolved);
}

export async function importFromInstalledPlugins(): Promise<{
  imported: string[];
  skipped: string[];
  errors: string[];
}> {
  // No filesystem discovery in demo mode.
  return { imported: [], skipped: [], errors: [] };
}
