export const dynamic = 'force-dynamic';

import { AgentTable } from '@/components/agents/agent-table';
import { listAgents } from '@/lib/services/agent-service';

export default async function ToolsPage() {
  const tools = await listAgents({ group: 'tools' });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">CLI Tools</h1>
      </div>

      {tools.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">
            No CLI tools registered. Run a discovery scan from the AI Agents page to find tools on your system.
          </p>
        </div>
      ) : (
        <AgentTable agents={tools} />
      )}
    </div>
  );
}
