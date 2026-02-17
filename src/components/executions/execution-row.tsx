'use client';

import Link from 'next/link';
import { formatDistanceStrict } from 'date-fns';
import { ExecutionStatusBadge } from './execution-status-badge';
import { ExecutionCancelButton } from './execution-cancel-button';
import { TableCell, TableRow } from '@/components/ui/table';
import type { Execution, ExecutionStatus } from '@/lib/types';

interface ExecutionRowProps {
  execution: Execution;
  onCancelled?: () => void;
}

const ACTIVE_STATUSES = new Set<ExecutionStatus>(['queued', 'running']);

function formatDuration(startedAt: Date | null, endedAt: Date | null): string {
  if (!startedAt) return '-';
  const end = endedAt ?? new Date();
  return formatDistanceStrict(startedAt, end);
}

export function ExecutionRow({ execution, onCancelled }: ExecutionRowProps) {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">
        <Link
          href={`/executions/${execution.id}`}
          className="text-primary underline-offset-4 hover:underline"
        >
          {execution.id.slice(0, 8)}
        </Link>
      </TableCell>
      <TableCell>
        <ExecutionStatusBadge status={execution.status} />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {formatDuration(execution.startedAt, execution.endedAt)}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {execution.exitCode !== null ? execution.exitCode : '-'}
      </TableCell>
      <TableCell className="text-right">
        {ACTIVE_STATUSES.has(execution.status) && (
          <ExecutionCancelButton
            executionId={execution.id}
            status={execution.status}
            onCancelled={onCancelled}
          />
        )}
      </TableCell>
    </TableRow>
  );
}
