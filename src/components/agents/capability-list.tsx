'use client';

import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { CapabilityRow } from './capability-row';
import type { AgentCapability } from '@/lib/types';

interface CapabilityListProps {
  agentId: string;
}

export function CapabilityList({ agentId }: CapabilityListProps) {
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchCapabilities() {
      try {
        const res = await fetch(`/api/agents/${agentId}/capabilities`);
        if (!res.ok) {
          throw new Error(`Failed to fetch capabilities: ${res.status}`);
        }
        const json = await res.json() as { data: AgentCapability[] };
        if (!cancelled) {
          setCapabilities(json.data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load capabilities');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchCapabilities();
    return () => { cancelled = true; };
  }, [agentId]);

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-destructive">{error}</div>
    );
  }

  if (capabilities.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">No capabilities found.</div>
    );
  }

  return (
    <div className="space-y-1 p-4">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        {capabilities.length} {capabilities.length === 1 ? 'capability' : 'capabilities'}
      </p>
      {capabilities.map((cap) => (
        <CapabilityRow key={cap.id} capability={cap} />
      ))}
    </div>
  );
}
