import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AgentStatusBadge } from '@/components/agents/agent-status-badge';
import { CapabilityRow } from '@/components/agents/capability-row';
import { getAgentById } from '@/lib/services/agent-service';
import { getCapabilitiesByAgent } from '@/lib/services/capability-service';

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let agent;
  try {
    agent = await getAgentById(id);
  } catch {
    notFound();
  }

  const capabilities = await getCapabilitiesByAgent(id);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" asChild>
          <Link href="/agents">Back to Agents</Link>
        </Button>
        <h1 className="text-2xl font-bold">{agent.name}</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Agent Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Name</dt>
              <dd className="mt-1 text-sm">{agent.name}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Binary Path</dt>
              <dd className="mt-1 text-sm font-mono">{agent.binaryPath}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Type</dt>
              <dd className="mt-1 text-sm">{agent.toolType ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Version</dt>
              <dd className="mt-1 text-sm">{agent.version ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Status</dt>
              <dd className="mt-1">
                <AgentStatusBadge isActive={agent.isActive} />
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Kind</dt>
              <dd className="mt-1">
                <Badge variant="outline">{agent.kind}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Discovery Method</dt>
              <dd className="mt-1">
                <Badge variant="outline">{agent.discoveryMethod}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-muted-foreground">Slug</dt>
              <dd className="mt-1 text-sm font-mono">{agent.slug}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Capabilities ({capabilities.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {capabilities.length === 0 ? (
            <p className="text-sm text-muted-foreground">No capabilities configured.</p>
          ) : (
            <div className="space-y-2">
              {capabilities.map((cap) => (
                <CapabilityRow key={cap.id} capability={cap} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
