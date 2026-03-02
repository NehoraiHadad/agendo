'use client';

import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { AddCapabilityDialog } from './add-capability-dialog';
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

  useEffect(() => {
    if (initialCapabilities) return;
    const controller = new AbortController();
    const { signal } = controller;
    setIsLoading(true);

    async function loadCapabilities() {
      try {
        const res = await apiFetch<ApiResponse<AgentCapability[]>>(
          `/api/agents/${agentId}/capabilities`,
          { signal },
        );
        if (!signal.aborted) setCapabilities(res.data);
      } catch (err) {
        if (!signal.aborted) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load');
        }
      } finally {
        if (!signal.aborted) setIsLoading(false);
      }
    }

    void loadCapabilities();
    return () => {
      controller.abort();
    };
  }, [agentId, initialCapabilities]);

  function handleCreated(cap: AgentCapability) {
    setCapabilities((prev) => [...prev, cap]);
  }

  function handleToggle(id: string, isEnabled: boolean) {
    setCapabilities((prev) => prev.map((c) => (c.id === id ? { ...c, isEnabled } : c)));
  }

  function handleDelete(id: string) {
    setCapabilities((prev) => prev.filter((c) => c.id !== id));
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
        <AddCapabilityDialog agentId={agentId} onCreated={handleCreated} />
      </div>

      {capabilities.length === 0 ? (
        <p className="text-xs text-muted-foreground/60">
          No capabilities configured. Add one manually.
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
