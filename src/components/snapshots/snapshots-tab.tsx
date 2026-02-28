'use client';

import { useState, useEffect, useCallback } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { SnapshotCard } from './snapshot-card';
import type { ContextSnapshot } from '@/lib/types';

interface SnapshotsTabProps {
  projectId: string;
}

export function SnapshotsTab({ projectId }: SnapshotsTabProps) {
  const [snapshots, setSnapshots] = useState<ContextSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSnapshots = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/snapshots?projectId=${projectId}&limit=50`);
      if (!res.ok) throw new Error('Failed to load snapshots');
      const body = (await res.json()) as { data: ContextSnapshot[] };
      setSnapshots(body.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchSnapshots();
  }, [fetchSnapshots]);

  function handleDeleted(id: string) {
    setSnapshots((prev) => prev.filter((s) => s.id !== id));
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 text-muted-foreground/40 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-destructive/70">{error}</p>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="text-center py-14">
        {/* Decorative icon cluster */}
        <div className="relative mx-auto w-12 h-12 mb-4">
          <div className="absolute inset-0 rounded-xl bg-teal-500/5 border border-teal-500/10" />
          <Camera className="absolute inset-0 m-auto size-5 text-teal-400/30" />
        </div>
        <p className="text-sm font-medium text-foreground/50 mb-1">No snapshots yet</p>
        <p className="text-xs text-muted-foreground/40 max-w-[260px] mx-auto leading-relaxed">
          Save investigation context from active sessions using the{' '}
          <span className="text-teal-400/60">camera</span> button in any session.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {snapshots.map((snapshot) => (
        <SnapshotCard key={snapshot.id} snapshot={snapshot} onDeleted={handleDeleted} />
      ))}
    </div>
  );
}
