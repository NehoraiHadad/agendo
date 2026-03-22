'use client';

import { useEffect, useState, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { CheckCircle2, HelpCircle, XCircle, Filter, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

// ---------------------------------------------------------------------------
// Types (matching API response shape)
// ---------------------------------------------------------------------------

interface Capability {
  id: string;
  key: string;
  label: string;
  description: string | null;
  interactionMode: 'template' | 'prompt';
  supportStatus: 'verified' | 'untested' | 'unsupported';
  providerNotes: string | null;
  isEnabled: boolean;
  lastTestedAt: string | null;
}

type StatusFilter = 'all' | 'verified' | 'untested' | 'unsupported';

// ---------------------------------------------------------------------------
// Status badge helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG = {
  verified: {
    icon: CheckCircle2,
    label: 'Verified',
    className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  },
  untested: {
    icon: HelpCircle,
    label: 'Untested',
    className: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  },
  unsupported: {
    icon: XCircle,
    label: 'Unsupported',
    className: 'bg-red-500/10 text-red-400 border-red-500/20',
  },
} as const;

function StatusBadge({ status }: { status: Capability['supportStatus'] }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={`gap-1 text-[10px] px-1.5 py-0 ${config.className}`}>
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CapabilityMatrix({ agentId }: { agentId: string }) {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const fetchCapabilities = useCallback(async () => {
    try {
      const url = new URL(`/api/agents/${agentId}/capabilities`, window.location.origin);
      if (filter !== 'all') url.searchParams.set('supportStatus', filter);
      const res = await fetch(url.toString());
      if (res.ok) {
        const json = await res.json();
        setCapabilities(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, [agentId, filter]);

  useEffect(() => {
    setLoading(true);
    fetchCapabilities();
  }, [fetchCapabilities]);

  const handleToggle = async (capId: string, enabled: boolean) => {
    setToggling((prev) => new Set(prev).add(capId));
    try {
      const res = await fetch(`/api/agents/${agentId}/capabilities/${capId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: enabled }),
      });
      if (res.ok) {
        setCapabilities((prev) =>
          prev.map((c) => (c.id === capId ? { ...c, isEnabled: enabled } : c)),
        );
      }
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(capId);
        return next;
      });
    }
  };

  // Group by support status for display
  const verified = capabilities.filter((c) => c.supportStatus === 'verified');
  const untested = capabilities.filter((c) => c.supportStatus === 'untested');
  const unsupported = capabilities.filter((c) => c.supportStatus === 'unsupported');

  const counts = {
    all: capabilities.length,
    verified: verified.length,
    untested: untested.length,
    unsupported: unsupported.length,
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground/60">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading capabilities...
      </div>
    );
  }

  if (capabilities.length === 0 && filter === 'all') {
    return (
      <div className="text-center py-8 text-muted-foreground/60 text-sm">
        No capabilities registered for this agent.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter buttons */}
      <div className="flex items-center gap-2">
        <Filter className="h-3.5 w-3.5 text-muted-foreground/50" />
        {(['all', 'verified', 'untested', 'unsupported'] as const).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : STATUS_CONFIG[f].label}
            <span className="ml-1 text-muted-foreground/50">({counts[f]})</span>
          </Button>
        ))}
      </div>

      {/* Capability list */}
      <TooltipProvider delayDuration={200}>
        <div className="space-y-1">
          {capabilities.map((cap) => (
            <div
              key={cap.id}
              className={`flex items-center justify-between rounded-md px-3 py-2 transition-colors ${
                cap.isEnabled
                  ? 'bg-white/[0.02] hover:bg-white/[0.04]'
                  : 'bg-white/[0.01] opacity-60'
              }`}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <StatusBadge status={cap.supportStatus} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground/80 truncate">
                      {cap.label}
                    </span>
                    <Badge
                      variant="outline"
                      className="text-[9px] px-1 py-0 border-white/[0.06] text-muted-foreground/50"
                    >
                      {cap.interactionMode}
                    </Badge>
                  </div>
                  {cap.providerNotes && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p className="text-xs text-muted-foreground/50 truncate max-w-md cursor-help">
                          {cap.providerNotes}
                        </p>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-sm">
                        <p className="text-xs">{cap.providerNotes}</p>
                        {cap.description && (
                          <p className="text-xs text-muted-foreground mt-1">{cap.description}</p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 ml-3">
                {cap.lastTestedAt && (
                  <span className="text-[10px] text-muted-foreground/40">
                    {new Date(cap.lastTestedAt).toLocaleDateString()}
                  </span>
                )}
                <Switch
                  checked={cap.isEnabled}
                  disabled={toggling.has(cap.id)}
                  onCheckedChange={(checked) => handleToggle(cap.id, checked)}
                  className="scale-75"
                />
              </div>
            </div>
          ))}
        </div>
      </TooltipProvider>

      {capabilities.length === 0 && filter !== 'all' && (
        <div className="text-center py-4 text-muted-foreground/50 text-xs">
          No {filter} capabilities found.
        </div>
      )}
    </div>
  );
}
