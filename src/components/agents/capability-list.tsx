'use client';

import { useEffect, useState, useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { syncCapabilities } from '@/lib/actions/discovery-actions';
import { AddCapabilityDialog } from './add-capability-dialog';
import { AICapabilitiesReview } from './ai-capabilities-review';
import { CapabilityRow } from './capability-row';
import { apiFetch, type ApiResponse } from '@/lib/api-types';
import type { AgentCapability } from '@/lib/types';

interface CapabilityListProps {
  agentId: string;
  initialCapabilities?: AgentCapability[];
}

export function CapabilityList({ agentId, initialCapabilities }: CapabilityListProps) {
  const [capabilities, setCapabilities] = useState<AgentCapability[]>(initialCapabilities ?? []);
  const [isLoading, setIsLoading] = useState(!initialCapabilities);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [isSyncing, startSync] = useTransition();

  useEffect(() => {
    if (initialCapabilities) return;
    let cancelled = false;
    setIsLoading(true);
    apiFetch<ApiResponse<AgentCapability[]>>(`/api/agents/${agentId}/capabilities`)
      .then((res) => { if (!cancelled) setCapabilities(res.data); })
      .catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, initialCapabilities]);

  function handleCreated(cap: AgentCapability) {
    setCapabilities((prev) => [...prev, cap]);
  }

  function handleBulkCreated(caps: AgentCapability[]) {
    setCapabilities((prev) => [...prev, ...caps]);
  }

  function handleToggle(id: string, isEnabled: boolean) {
    setCapabilities((prev) => prev.map((c) => (c.id === id ? { ...c, isEnabled } : c)));
  }

  function handleDelete(id: string) {
    setCapabilities((prev) => prev.filter((c) => c.id !== id));
  }

  function handleSync() {
    setSyncError(null);
    startSync(async () => {
      const result = await syncCapabilities(agentId);
      if (result.success && result.added?.length) {
        setCapabilities((prev) => [...prev, ...result.added!]);
      } else if (!result.success) {
        setSyncError(result.error ?? 'Sync failed');
      }
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (loadError) {
    return <div className="text-sm text-destructive">{loadError}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground shrink-0">
          {capabilities.length} {capabilities.length === 1 ? 'capability' : 'capabilities'}
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleSync}
            disabled={isSyncing}
            title="Detect commands from --help output"
            className="px-2 sm:px-3"
          >
            <RefreshCw className={`size-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline ml-1.5">{isSyncing ? 'Syncing…' : 'Sync'}</span>
          </Button>
          <AICapabilitiesReview agentId={agentId} onCreated={handleBulkCreated} />
          <AddCapabilityDialog agentId={agentId} onCreated={handleCreated} />
        </div>
      </div>

      {syncError && (
        <p className="text-xs text-muted-foreground border border-dashed rounded px-3 py-2">
          {syncError}
        </p>
      )}

      {capabilities.length === 0 ? (
        <p className="text-xs text-muted-foreground/60">
          No capabilities configured. Click &quot;Sync from --help&quot; to auto-detect, or add manually.
        </p>
      ) : (
        <div className="space-y-2">
          {capabilities.map((cap) => (
            <CapabilityRow
              key={cap.id}
              capability={cap}
              onToggle={handleToggle}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
