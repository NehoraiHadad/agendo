'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { apiFetch, type ApiListResponse } from '@/lib/api-types';
import { SessionStatusBadge } from '@/components/sessions/session-table';
import { StartSessionDialog } from '@/components/sessions/start-session-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { Session } from '@/lib/types';

interface TaskExecutionHistoryProps {
  taskId: string;
  agentId?: string | null;
}

export function TaskExecutionHistory({ taskId, agentId }: TaskExecutionHistoryProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    async function loadAll() {
      try {
        const sessResult = await apiFetch<ApiListResponse<Session>>(
          `/api/sessions?taskId=${taskId}&pageSize=10`,
          { signal },
        );
        if (signal.aborted) return;
        setSessions(sessResult.data);
      } catch {
        // Network error or abort — leave state as empty arrays
      } finally {
        if (!signal.aborted) setIsLoading(false);
      }
    }

    void loadAll();

    return () => {
      controller.abort();
    };
  }, [taskId]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Agent Sessions</h3>
        <StartSessionDialog taskId={taskId} agentId={agentId ?? undefined} />
      </div>

      {isLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {!isLoading && sessions.length === 0 && (
        <p className="text-sm text-muted-foreground">No sessions yet.</p>
      )}

      {!isLoading && sessions.length > 0 && (
        <div className="flex flex-col gap-1">
          {sessions.map((sess) => (
            <Link
              key={sess.id}
              href={`/sessions/${sess.id}`}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {sess.id.slice(0, 8)}
                </span>
                <SessionStatusBadge status={sess.status} />
                <span className="text-xs text-muted-foreground/60">
                  {sess.totalTurns} turn{sess.totalTurns !== 1 ? 's' : ''}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDistanceToNow(sess.createdAt, { addSuffix: true })}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
