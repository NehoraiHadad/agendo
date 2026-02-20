'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceStrict, formatDistanceToNow } from 'date-fns';
import { apiFetch, type ApiListResponse } from '@/lib/api-types';
import { ExecutionStatusBadge } from '@/components/executions/execution-status-badge';
import { SessionStatusBadge } from '@/components/sessions/session-table';
import { ExecutionTriggerDialog } from '@/components/executions/execution-trigger-dialog';
import { StartSessionDialog } from '@/components/sessions/start-session-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import type { Execution, Session } from '@/lib/types';

interface TaskExecutionHistoryProps {
  taskId: string;
  agentId?: string | null;
}

export function TaskExecutionHistory({ taskId, agentId }: TaskExecutionHistoryProps) {
  const router = useRouter();
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoadingExec, setIsLoadingExec] = useState(true);
  const [isLoadingSess, setIsLoadingSess] = useState(true);

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
        if (!cancelled) setIsLoadingExec(false);
      });

    apiFetch<ApiListResponse<Session>>(`/api/sessions?taskId=${taskId}&pageSize=10`)
      .then((result) => {
        if (!cancelled) setSessions(result.data);
      })
      .catch(() => {
        // Network error
      })
      .finally(() => {
        if (!cancelled) setIsLoadingSess(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskId]);

  function handleExecutionCreated(exec: Execution) {
    setExecutions((prev) => [exec, ...prev]);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Agent Sessions */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Agent Sessions</h3>
          <StartSessionDialog
            taskId={taskId}
            agentId={agentId ?? undefined}
          />
        </div>

        {isLoadingSess && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {!isLoadingSess && sessions.length === 0 && (
          <p className="text-sm text-muted-foreground">No sessions yet.</p>
        )}

        {!isLoadingSess && sessions.length > 0 && (
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

      {/* CLI Commands */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">CLI Commands</h3>
          <ExecutionTriggerDialog
            taskId={taskId}
            agentId={agentId ?? undefined}
            onExecutionCreated={handleExecutionCreated}
          />
        </div>

        {isLoadingExec && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {!isLoadingExec && executions.length === 0 && (
          <p className="text-sm text-muted-foreground">No executions yet.</p>
        )}

        {!isLoadingExec && executions.length > 0 && (
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
    </div>
  );
}
