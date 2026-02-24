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
    <TableRow className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
      <TableCell className="font-mono text-xs">
        <Link
          href={`/executions/${execution.id}`}
          className="font-mono text-xs text-muted-foreground/70 hover:text-primary transition-colors no-underline hover:no-underline"
        >
          {execution.id.slice(0, 8)}
        </Link>
      </TableCell>
      <TableCell>
        <ExecutionStatusBadge status={execution.status} />
      </TableCell>
      <TableCell className="hidden sm:table-cell text-xs font-mono text-muted-foreground/70">
        {formatDuration(execution.startedAt, execution.endedAt)}
      </TableCell>
      <TableCell className="hidden sm:table-cell text-xs font-mono text-muted-foreground/60">
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
