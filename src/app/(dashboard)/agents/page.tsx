export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { AgentTable } from '@/components/agents/agent-table';
import { listAgents } from '@/lib/services/agent-service';

export default async function AgentsPage() {
  const agents = await listAgents({ group: 'ai' });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">AI Agents</h1>
        <Button asChild>
          <Link href="/agents/discovery">Discover</Link>
        </Button>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-muted-foreground">
            No AI agents registered. Run a discovery scan to find Claude, Codex, and other AI agents.
          </p>
        </div>
      ) : (
        <AgentTable agents={agents} />
      )}
    </div>
  );
}
