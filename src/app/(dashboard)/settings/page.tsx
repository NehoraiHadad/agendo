export const dynamic = 'force-dynamic';

import { listAgents } from '@/lib/services/agent-service';
import { listMcpServers } from '@/lib/services/mcp-server-service';
import { listProjects } from '@/lib/services/project-service';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const [agents, mcpServers, activeProjects] = await Promise.all([
    listAgents(),
    listMcpServers(),
    listProjects(true),
  ]);

  const allProjects = activeProjects.map((p) => ({
    id: p.id,
    name: p.name,
    rootPath: p.rootPath,
  }));

  return <SettingsClient agents={agents} mcpServers={mcpServers} projects={allProjects} />;
}
