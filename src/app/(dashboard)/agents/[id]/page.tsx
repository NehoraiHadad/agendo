import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { AgentStatusBadge } from '@/components/agents/agent-status-badge';
import { CapabilityList } from '@/components/agents/capability-list';
import { RefreshFlagsButton } from '@/components/agents/refresh-flags-button';
import { getAgentById } from '@/lib/services/agent-service';
import { getCapabilitiesByAgent } from '@/lib/services/capability-service';

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const agent = await getAgentById(id).catch(() => notFound());
  const capabilities = await getCapabilitiesByAgent(id);

  const backHref = agent.toolType === 'ai-agent' ? '/agents' : '/tools';
  const backLabel = agent.toolType === 'ai-agent' ? 'Back to AI Agents' : 'Back to Tools';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" asChild>
          <Link href={backHref}>{backLabel}</Link>
        </Button>
        <h1 className="text-2xl font-bold">{agent.name}</h1>
      </div>

      <Card className="border-white/[0.06]">
        <CardHeader>
          <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground/60 mb-3">Agent Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground/60">Name</dt>
              <dd className="mt-1 text-sm font-mono text-foreground/80">{agent.name}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground/60">Binary Path</dt>
              <dd className="mt-1 font-mono text-xs text-muted-foreground/70">{agent.binaryPath}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground/60">Type</dt>
              <dd className="mt-1 text-sm font-mono text-foreground/80">{agent.toolType ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground/60">Version</dt>
              <dd className="mt-1 text-sm font-mono text-foreground/80">{agent.version ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground/60">Status</dt>
              <dd className="mt-1">
                <AgentStatusBadge isActive={agent.isActive} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground/60">Kind</dt>
              <dd className="mt-1">
                <Badge variant="outline">{agent.kind}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground/60">Discovery Method</dt>
              <dd className="mt-1">
                <Badge variant="outline">{agent.discoveryMethod}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground/60">Slug</dt>
              <dd className="mt-1 font-mono text-xs text-muted-foreground/70">{agent.slug}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card className="border-white/[0.06]">
        <CardHeader>
          <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground/60 mb-3">Capabilities ({capabilities.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <CapabilityList agentId={id} initialCapabilities={capabilities} />
        </CardContent>
      </Card>

      <Card className="border-white/[0.06]">
        <CardHeader>
          <CardTitle className="text-xs uppercase tracking-widest text-muted-foreground/60 mb-3">CLI Flags</CardTitle>
        </CardHeader>
        <CardContent>
          <RefreshFlagsButton agentId={id} initialFlags={agent.parsedFlags ?? []} />
        </CardContent>
      </Card>
    </div>
  );
}
