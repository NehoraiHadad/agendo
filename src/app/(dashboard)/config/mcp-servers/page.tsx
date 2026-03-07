export const dynamic = 'force-dynamic';

import { listMcpServers } from '@/lib/services/mcp-server-service';
import { McpServersClient } from '@/components/mcp/mcp-servers-client';

export default async function McpServersPage() {
  const servers = await listMcpServers();

  return (
    <div className="flex flex-col h-full min-h-0">
      <McpServersClient initialServers={servers} />
    </div>
  );
}
