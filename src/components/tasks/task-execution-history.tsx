'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceStrict } from 'date-fns';
import { apiFetch, type ApiListResponse } from '@/lib/api-types';
import { ExecutionStatusBadge } from '@/components/executions/execution-status-badge';
import { ExecutionTriggerDialog } from '@/components/executions/execution-trigger-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { Execution } from '@/lib/types';

interface TaskExecutionHistoryProps {
  taskId: string;
  agentId?: string | null;
}

export function TaskExecutionHistory({ taskId, agentId }: TaskExecutionHistoryProps) {
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    apiFetch<ApiListResponse<Execution>>(`/api/executions?taskId=${taskId}&pageSize=10`)
      .then((result) => {
        if (!cancelled) setExecutions(result.data);
      })
      .catch(() => {
        // Network error
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  function handleExecutionCreated(exec: Execution) {
    setExecutions((prev) => [exec, ...prev]);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Execution History</h3>
        <ExecutionTriggerDialog
          taskId={taskId}
          agentId={agentId ?? undefined}
          onExecutionCreated={handleExecutionCreated}
        />
      </div>

      {isLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}

      {!isLoading && executions.length === 0 && (
        <p className="text-sm text-muted-foreground">No executions yet.</p>
      )}

      {!isLoading && executions.length > 0 && (
        <div className="flex flex-col gap-1">
          {executions.map((exec) => (
            <Link
              key={exec.id}
              href={`/executions/${exec.id}`}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {exec.id.slice(0, 8)}
                </span>
                <ExecutionStatusBadge status={exec.status} />
              </div>
              <span className="text-xs text-muted-foreground">
                {exec.startedAt
                  ? formatDistanceStrict(exec.startedAt, exec.endedAt ?? new Date())
                  : 'Queued'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
