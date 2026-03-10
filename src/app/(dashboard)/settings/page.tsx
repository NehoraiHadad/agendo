export const dynamic = 'force-dynamic';

import { listAgents } from '@/lib/services/agent-service';
import { listMcpServers } from '@/lib/services/mcp-server-service';
import { db } from '@/lib/db';
import { projects } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { SettingsClient } from './settings-client';

export default async function SettingsPage() {
  const [agents, mcpServers, allProjects] = await Promise.all([
    listAgents(),
    listMcpServers(),
    db
      .select({ id: projects.id, name: projects.name, rootPath: projects.rootPath })
      .from(projects)
      .where(eq(projects.isActive, true)),
  ]);

  return <SettingsClient agents={agents} mcpServers={mcpServers} projects={allProjects} />;
}
