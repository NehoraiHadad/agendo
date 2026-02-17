'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ExecutionStatusBadge } from '@/components/executions/execution-status-badge';
import { ExecutionCancelButton } from '@/components/executions/execution-cancel-button';
import { apiFetch } from '@/lib/api-types';
import { formatDistanceToNow } from 'date-fns';
import type { ActiveExecution } from '@/lib/services/dashboard-service';
import type { ExecutionStatus } from '@/lib/types';

interface ActiveExecutionsListProps {
  initialData: ActiveExecution[];
}

export function ActiveExecutionsList({ initialData }: ActiveExecutionsListProps) {
  const [executions, setExecutions] = useState<ActiveExecution[]>(initialData);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const result = await apiFetch<{ data: ActiveExecution[] }>(
          '/api/dashboard?view=active-executions',
        );
        setExecutions(result.data);
      } catch {
        /* polling failure, keep stale data */
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Active Executions</CardTitle>
      </CardHeader>
      <CardContent>
        {executions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active executions</p>
        ) : (
          <div className="space-y-3">
            {executions.map((exec) => (
              <div
                key={exec.id}
                className="flex items-center justify-between gap-2 rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{exec.agentName}</p>
                  <p className="text-xs text-muted-foreground">
                    {exec.startedAt
                      ? formatDistanceToNow(new Date(exec.startedAt), { addSuffix: true })
                      : 'Queued'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <ExecutionStatusBadge status={exec.status as ExecutionStatus} />
                  <ExecutionCancelButton
                    executionId={exec.id}
                    status={exec.status as ExecutionStatus}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
