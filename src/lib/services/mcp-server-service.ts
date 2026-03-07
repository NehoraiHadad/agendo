import * as fs from 'fs';
import * as path from 'path';
import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { mcpServers, projectMcpServers } from '@/lib/db/schema';
import type { McpServer, NewMcpServer, ProjectMcpServer } from '@/lib/types';

// --- CRUD ---

export async function listMcpServers(filters?: { enabled?: boolean }): Promise<McpServer[]> {
  const query = db.select().from(mcpServers);
  if (filters?.enabled !== undefined) {
    return query.where(eq(mcpServers.enabled, filters.enabled));
  }
  return query;
}

export async function getMcpServer(id: string): Promise<McpServer | null> {
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).limit(1);
  return server ?? null;
}

export async function getMcpServerByName(name: string): Promise<McpServer | null> {
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.name, name)).limit(1);
  return server ?? null;
}

export async function createMcpServer(data: NewMcpServer): Promise<McpServer> {
  const [server] = await db.insert(mcpServers).values(data).returning();
  return server;
}

export async function updateMcpServer(id: string, data: Partial<NewMcpServer>): Promise<McpServer> {
  const [updated] = await db
    .update(mcpServers)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(mcpServers.id, id))
    .returning();
  return updated;
}

export async function deleteMcpServer(id: string): Promise<void> {
  await db.delete(mcpServers).where(eq(mcpServers.id, id));
}

// --- Project Overrides ---

export async function getProjectMcpServers(
  projectId: string,
): Promise<(ProjectMcpServer & { mcpServer: McpServer })[]> {
  const rows = await db
    .select()
    .from(projectMcpServers)
    .innerJoin(mcpServers, eq(projectMcpServers.mcpServerId, mcpServers.id))
    .where(eq(projectMcpServers.projectId, projectId));

  return rows.map((row) => ({
    ...row.project_mcp_servers,
    mcpServer: row.mcp_servers,
  }));
}

export async function setProjectMcpOverride(
  projectId: string,
  mcpServerId: string,
  config: { enabled: boolean; envOverrides?: Record<string, string> },
): Promise<void> {
  await db
    .insert(projectMcpServers)
    .values({
      projectId,
      mcpServerId,
      enabled: config.enabled,
      envOverrides: config.envOverrides ?? {},
    })
    .onConflictDoUpdate({
      target: [projectMcpServers.projectId, projectMcpServers.mcpServerId],
      set: {
        enabled: config.enabled,
        envOverrides: config.envOverrides ?? {},
      },
    });
}

export async function removeProjectMcpOverride(
  projectId: string,
  mcpServerId: string,
): Promise<void> {
  await db
    .delete(projectMcpServers)
    .where(
      and(
        eq(projectMcpServers.projectId, projectId),
        eq(projectMcpServers.mcpServerId, mcpServerId),
      ),
    );
}

// --- Resolve Logic ---

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
 * Resolve the final list of MCP servers for a session in a given project.
 * 1. Load all enabled mcp_servers
 * 2. Load project_mcp_servers overrides for this project
 * 3. Start with servers where is_default = true
 * 4. Add project-enabled servers, remove project-disabled ones
 * 5. Apply env_overrides from project config
 * 6. Return resolved list (NOT including Agendo MCP — that's added by session-runner)
 */
export async function resolveSessionMcpServers(
  projectId: string | null,
): Promise<ResolvedMcpServer[]> {
  const allEnabled = await listMcpServers({ enabled: true });

  // Build a map for fast lookup
  const serverMap = new Map<string, McpServer>(allEnabled.map((s) => [s.id, s]));

  // Start with defaults
  const included = new Map<string, McpServer>(
    allEnabled.filter((s) => s.isDefault).map((s) => [s.id, s]),
  );

  // Apply project overrides if projectId is provided
  if (projectId) {
    const overrides = await getProjectMcpServers(projectId);
    for (const override of overrides) {
      const server = serverMap.get(override.mcpServerId);
      if (!server) continue;
      if (override.enabled) {
        included.set(server.id, server);
      } else {
        included.delete(server.id);
      }
    }

    // Apply env_overrides
    const overrideMap = new Map(overrides.map((o) => [o.mcpServerId, o]));
    const resolved: ResolvedMcpServer[] = [];
    for (const [id, server] of included) {
      const override = overrideMap.get(id);
      const mergedEnv = override?.envOverrides
        ? { ...(server.env ?? {}), ...override.envOverrides }
        : (server.env ?? {});

      resolved.push({
        name: server.name,
        transportType: server.transportType,
        command: server.command,
        args: server.args ?? [],
        env: mergedEnv,
        url: server.url,
        headers: server.headers ?? {},
      });
    }
    return resolved;
  }

  // No project — just return defaults
  return Array.from(included.values()).map((server) => ({
    name: server.name,
    transportType: server.transportType,
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
    url: server.url,
    headers: server.headers ?? {},
  }));
}

// --- Multi-Source Import ---

interface DiscoveredServer {
  name: string;
  transportType: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  source: string;
}

function expandHome(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(process.env.HOME ?? '/root', filePath.slice(1));
  }
  return filePath;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(expandHome(filePath), 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function discoverClaudePlugins(): DiscoveredServer[] {
  const pluginsFile = expandHome('~/.claude/plugins/installed_plugins.json');
  if (!fs.existsSync(pluginsFile)) return [];

  interface InstalledPlugin {
    installPath?: string;
    name?: string;
  }
  interface McpJson {
    name?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
    type?: string;
  }

  const plugins = readJsonFile<InstalledPlugin[]>(pluginsFile);
  if (!Array.isArray(plugins)) return [];

  const discovered: DiscoveredServer[] = [];
  for (const plugin of plugins) {
    if (!plugin.installPath) continue;
    const mcpJsonPath = path.join(plugin.installPath, '.mcp.json');
    const mcpDef = readJsonFile<McpJson>(mcpJsonPath);
    if (!mcpDef) continue;

    const name = mcpDef.name ?? plugin.name;
    if (!name) continue;

    const isHttp = mcpDef.type === 'http' || Boolean(mcpDef.url);
    discovered.push({
      name,
      transportType: isHttp ? 'http' : 'stdio',
      command: mcpDef.command,
      args: mcpDef.args,
      env: mcpDef.env,
      url: mcpDef.url,
      headers: mcpDef.headers,
      source: 'claude-plugin',
    });
  }
  return discovered;
}

function discoverGeminiSettings(): DiscoveredServer[] {
  interface GeminiMcpServer {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }
  interface GeminiSettings {
    mcpServers?: Record<string, GeminiMcpServer>;
  }

  const settings = readJsonFile<GeminiSettings>('~/.gemini/settings.json');
  if (!settings?.mcpServers) return [];

  return Object.entries(settings.mcpServers).map(([name, def]) => {
    const isHttp = Boolean(def.url);
    return {
      name,
      transportType: isHttp ? 'http' : ('stdio' as const),
      command: def.command,
      args: def.args,
      env: def.env,
      url: def.url,
      headers: def.headers,
      source: 'gemini-settings',
    };
  });
}

function discoverCodexConfig(): DiscoveredServer[] {
  // Prefer JSON backup over TOML (avoids needing a TOML parser)
  interface CodexMcpServer {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }
  interface CodexConfig {
    mcp_servers?: Record<string, CodexMcpServer>;
    mcpServers?: Record<string, CodexMcpServer>;
  }

  const config =
    readJsonFile<CodexConfig>('~/.codex/config.json.bak') ??
    readJsonFile<CodexConfig>('~/.codex/config.json');

  if (!config) return [];

  const serversObj = config.mcp_servers ?? config.mcpServers;
  if (!serversObj) return [];

  return Object.entries(serversObj).map(([name, def]) => {
    const isHttp = Boolean(def.url);
    return {
      name,
      transportType: isHttp ? 'http' : ('stdio' as const),
      command: def.command,
      args: def.args,
      env: def.env,
      url: def.url,
      headers: def.headers,
      source: 'codex-config',
    };
  });
}

/**
 * Import MCP servers from all installed CLI configs.
 * Sources:
 * 1. Claude plugins: ~/.claude/plugins/installed_plugins.json → each plugin's .mcp.json
 * 2. Gemini settings: ~/.gemini/settings.json → mcpServers object
 * 3. Codex config: ~/.codex/config.toml → uses JSON backup if available
 *
 * Dedup by name. Prefer stdio over http when same name exists in multiple sources.
 * Skip any server named 'agendo' (managed separately).
 * Returns { imported: string[], skipped: string[], errors: string[] }
 */
export async function importFromInstalledPlugins(): Promise<{
  imported: string[];
  skipped: string[];
  errors: string[];
}> {
  const imported: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  // Collect from all sources
  let allDiscovered: DiscoveredServer[] = [];
  const sources: Array<{ name: string; fn: () => DiscoveredServer[] }> = [
    { name: 'claude-plugins', fn: discoverClaudePlugins },
    { name: 'gemini-settings', fn: discoverGeminiSettings },
    { name: 'codex-config', fn: discoverCodexConfig },
  ];

  for (const { name, fn } of sources) {
    try {
      allDiscovered = allDiscovered.concat(fn());
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Dedup by name — prefer stdio over http, then first occurrence wins
  const dedupMap = new Map<string, DiscoveredServer>();
  for (const server of allDiscovered) {
    if (server.name === 'agendo') continue;
    const existing = dedupMap.get(server.name);
    if (!existing) {
      dedupMap.set(server.name, server);
    } else if (existing.transportType === 'http' && server.transportType === 'stdio') {
      // Prefer stdio
      dedupMap.set(server.name, server);
    }
  }

  // Upsert each discovered server
  for (const [name, server] of dedupMap) {
    try {
      await db
        .insert(mcpServers)
        .values({
          name,
          transportType: server.transportType,
          command: server.command ?? null,
          args: server.args ?? [],
          env: server.env ?? {},
          url: server.url ?? null,
          headers: server.headers ?? {},
          enabled: true,
          isDefault: false,
        })
        .onConflictDoUpdate({
          target: [mcpServers.name],
          set: {
            transportType: server.transportType,
            command: server.command ?? null,
            args: server.args ?? [],
            env: server.env ?? {},
            url: server.url ?? null,
            headers: server.headers ?? {},
            updatedAt: new Date(),
          },
        });
      imported.push(name);
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Report servers we skipped (agendo)
  const rawNames = allDiscovered.map((s) => s.name);
  for (const name of rawNames) {
    if (name === 'agendo') {
      skipped.push(name);
    }
  }

  return { imported, skipped: [...new Set(skipped)], errors };
}
