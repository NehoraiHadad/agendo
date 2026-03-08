'use client';

import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Bot, ChevronRight, Search as SearchIcon, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AgentWithCapabilities } from '@/lib/services/agent-service';

interface AgentCardsProps {
  initialAgents: AgentWithCapabilities[];
}

/** Binary path to a brand-ish color */
function agentColor(binaryPath: string): string {
  if (binaryPath.includes('claude')) return 'oklch(0.7 0.15 30)';
  if (binaryPath.includes('codex')) return 'oklch(0.7 0.15 145)';
  if (binaryPath.includes('gemini')) return 'oklch(0.7 0.15 250)';
  return 'oklch(0.6 0.1 280)';
}

function agentIcon(binaryPath: string) {
  if (binaryPath.includes('claude')) return '🟠';
  if (binaryPath.includes('codex')) return '🟢';
  if (binaryPath.includes('gemini')) return '🔵';
  return '🤖';
}

export function AgentCards({ initialAgents }: AgentCardsProps) {
  const [agents, setAgents] = useState(initialAgents);

  async function toggleActive(agentId: string, isActive: boolean) {
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, isActive } : a)));
      toast.success(isActive ? 'Agent enabled' : 'Agent disabled');
    } catch {
      toast.error('Failed to update agent');
    }
  }

  async function toggleMcp(agentId: string, mcpEnabled: boolean) {
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mcpEnabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, mcpEnabled } : a)));
      toast.success(mcpEnabled ? 'MCP enabled' : 'MCP disabled');
    } catch {
      toast.error('Failed to update MCP setting');
    }
  }

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground/40">
          {agents.length} agent{agents.length !== 1 ? 's' : ''} registered
        </p>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" asChild>
          <Link href="/agents/discovery">
            <SearchIcon className="h-3 w-3" />
            Discover
          </Link>
        </Button>
      </div>

      {agents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/[0.08] p-12 text-center">
          <Bot className="h-10 w-10 mx-auto text-muted-foreground/20 mb-3" />
          <p className="text-sm text-muted-foreground mb-4">
            No AI agents registered. Run a discovery scan to find Claude, Codex, and Gemini.
          </p>
          <Button size="sm" asChild>
            <Link href="/agents/discovery">Discover Agents</Link>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {agents.map((agent) => {
            const color = agentColor(agent.binaryPath);
            const icon = agentIcon(agent.binaryPath);
            const capCount = agent.capabilities.length;

            return (
              <div
                key={agent.id}
                className={cn(
                  'group relative rounded-xl border overflow-hidden transition-all duration-200',
                  'hover:border-white/[0.12]',
                  agent.isActive
                    ? 'border-white/[0.08] bg-white/[0.015]'
                    : 'border-white/[0.04] bg-white/[0.005] opacity-60',
                )}
              >
                {/* Top accent bar */}
                <div
                  className="h-[2px] w-full"
                  style={{
                    background: `linear-gradient(90deg, ${color} 0%, transparent 100%)`,
                    opacity: agent.isActive ? 0.6 : 0.2,
                  }}
                />

                <div className="p-4 space-y-3">
                  {/* Header row */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-lg shrink-0" role="img" aria-label={agent.name}>
                        {icon}
                      </span>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-foreground/90 truncate">
                          {agent.name}
                        </h3>
                        <p className="text-[10px] text-muted-foreground/35 font-mono truncate">
                          {agent.version ?? 'unknown'} &middot; {agent.slug}
                        </p>
                      </div>
                    </div>
                    <Link
                      href={`/agents/${agent.id}`}
                      className="shrink-0 p-1.5 rounded-md text-muted-foreground/30 hover:text-foreground/60 hover:bg-white/[0.04] transition-colors"
                      aria-label={`${agent.name} details`}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </div>

                  {/* Capabilities summary */}
                  <div className="flex flex-wrap gap-1.5">
                    {capCount > 0 ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] border-blue-500/20 text-blue-400/70 bg-blue-500/[0.06] gap-1"
                      >
                        <Zap className="h-2.5 w-2.5" />
                        {capCount} capabilit{capCount !== 1 ? 'ies' : 'y'}
                      </Badge>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/25">No capabilities</span>
                    )}
                  </div>

                  {/* Quick toggles */}
                  <div className="flex items-center gap-4 pt-2 border-t border-white/[0.04]">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={agent.isActive}
                        onCheckedChange={(v) => toggleActive(agent.id, v)}
                        aria-label={`Toggle ${agent.name} active`}
                        className="scale-90"
                      />
                      <span className="text-[11px] text-muted-foreground/45">Active</span>
                    </div>
                    {agent.toolType === 'ai-agent' && (
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={agent.mcpEnabled ?? false}
                          onCheckedChange={(v) => toggleMcp(agent.id, v)}
                          aria-label={`Toggle ${agent.name} MCP`}
                          className="scale-90"
                        />
                        <span className="text-[11px] text-muted-foreground/45">MCP</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
