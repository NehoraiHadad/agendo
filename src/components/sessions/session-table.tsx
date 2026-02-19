'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatDistanceStrict, formatDistanceToNow } from 'date-fns';
import {
  Activity,
  Clock,
  MessageSquare,
  MinusCircle,
  Pause,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell } from '@/components/ui/table';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { apiFetch, type ApiListResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import type { Session, SessionStatus } from '@/lib/types';

// ---------------------------------------------------------------------------
// SessionStatusBadge
// ---------------------------------------------------------------------------

interface StatusConfig {
  label: string;
  icon: React.ElementType;
  className: string;
  pulse?: boolean;
}

const SESSION_STATUS_CONFIG: Record<SessionStatus, StatusConfig> = {
  active: {
    label: 'Active',
    icon: Activity,
    className:
      'bg-blue-500/15 text-blue-400 border border-blue-500/30 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
    pulse: true,
  },
  awaiting_input: {
    label: 'Your Turn',
    icon: MessageSquare,
    className:
      'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
    pulse: true,
  },
  idle: {
    label: 'Idle',
    icon: Pause,
    className:
      'bg-zinc-500/15 text-zinc-400 border border-zinc-500/25 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
  },
  ended: {
    label: 'Ended',
    icon: MinusCircle,
    className:
      'bg-zinc-600/15 text-zinc-500 border border-zinc-600/20 text-xs px-2.5 py-1 rounded-full font-medium gap-1.5',
  },
};

interface SessionStatusBadgeProps {
  status: SessionStatus;
  className?: string;
}

export function SessionStatusBadge({ status, className }: SessionStatusBadgeProps) {
  const config = SESSION_STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <Badge className={cn(config.className, className)}>
      {config.pulse ? (
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full shrink-0 animate-pulse',
            status === 'active' ? 'bg-blue-400' : 'bg-emerald-400',
          )}
        />
      ) : (
        <Icon className="size-3 shrink-0" />
      )}
      {config.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// SessionRow
// ---------------------------------------------------------------------------

interface SessionWithDetails extends Session {
  agentName?: string | null;
  taskTitle?: string | null;
}

function formatDuration(startedAt: Date | null, endedAt: Date | null): string {
  if (!startedAt) return '-';
  const end = endedAt ?? new Date();
  return formatDistanceStrict(startedAt, end);
}

interface SessionRowProps {
  session: SessionWithDetails;
}

function SessionRow({ session }: SessionRowProps) {
  return (
    <TableRow className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
      <TableCell className="font-mono text-xs">
        <Link
          href={`/sessions/${session.id}`}
          className="font-mono text-xs text-muted-foreground/70 hover:text-primary transition-colors no-underline hover:no-underline"
        >
          {session.id.slice(0, 8)}
        </Link>
      </TableCell>
      <TableCell>
        <SessionStatusBadge status={session.status} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground/70 max-w-[180px] truncate">
        {session.agentName ?? '-'}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground/60 max-w-[200px] truncate">
        {session.taskTitle ?? '-'}
      </TableCell>
      <TableCell className="text-xs font-mono text-muted-foreground/70">
        {session.totalTurns}
      </TableCell>
      <TableCell className="text-xs font-mono text-muted-foreground/60">
        {session.totalCostUsd != null ? `$${Number(session.totalCostUsd).toFixed(4)}` : '-'}
      </TableCell>
      <TableCell className="text-xs font-mono text-muted-foreground/70">
        {formatDuration(session.startedAt, session.endedAt)}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground/50" suppressHydrationWarning>
        {formatDistanceToNow(session.createdAt, { addSuffix: true })}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// SessionTable
// ---------------------------------------------------------------------------

const ALL_STATUSES: SessionStatus[] = ['active', 'awaiting_input', 'idle', 'ended'];

interface SessionTableProps {
  taskId?: string;
}

export function SessionTable({ taskId }: SessionTableProps) {
  const [data, setData] = useState<SessionWithDetails[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageSize: 20 });
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 56,
    overscan: 20,
  });

  const fetchSessions = useCallback(
    async (page: number, status: string) => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams();
        if (status !== 'all') params.set('status', status);
        if (taskId) params.set('taskId', taskId);
        params.set('page', String(page));
        params.set('pageSize', String(meta.pageSize));

        const result = await apiFetch<ApiListResponse<SessionWithDetails>>(
          `/api/sessions?${params.toString()}`,
        );
        setData(result.data);
        setMeta(result.meta);
      } finally {
        setIsLoading(false);
      }
    },
    [meta.pageSize, taskId],
  );

  useEffect(() => {
    fetchSessions(1, statusFilter);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    fetchSessions(1, value);
  };

  const handlePrevPage = () => {
    if (meta.page > 1) fetchSessions(meta.page - 1, statusFilter);
  };

  const handleNextPage = () => {
    const totalPages = Math.ceil(meta.total / meta.pageSize);
    if (meta.page < totalPages) fetchSessions(meta.page + 1, statusFilter);
  };

  const totalPages = Math.ceil(meta.total / meta.pageSize);
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 mb-2">
        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-[160px] border-white/[0.08] bg-white/[0.04]">
            <SelectValue placeholder="Filter by status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {ALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.replace('_', ' ')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isLoading && <span className="text-sm text-muted-foreground/60">Loading...</span>}
      </div>

      <div
        ref={scrollContainerRef}
        className="rounded-xl border border-white/[0.06] overflow-hidden overflow-y-auto"
        style={{ maxHeight: '70vh' }}
      >
        <Table>
          <TableHeader className="bg-white/[0.02]">
            <TableRow>
              <TableHead className="w-[100px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                ID
              </TableHead>
              <TableHead className="w-[130px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Status
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Agent
              </TableHead>
              <TableHead className="text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Task
              </TableHead>
              <TableHead className="w-[70px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Turns
              </TableHead>
              <TableHead className="w-[90px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Cost
              </TableHead>
              <TableHead className="w-[110px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Duration
              </TableHead>
              <TableHead className="w-[120px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Created
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!isLoading && data.length === 0 ? (
              <TableRow>
                <TableHead colSpan={8} className="h-24 text-center">
                  No sessions found.
                </TableHead>
              </TableRow>
            ) : (
              <>
                {virtualItems[0]?.start > 0 && (
                  <tr>
                    <td colSpan={8} style={{ height: virtualItems[0].start }} />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => (
                  <SessionRow key={data[virtualRow.index].id} session={data[virtualRow.index]} />
                ))}
                {virtualItems.length > 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      style={{
                        height: virtualizer.getTotalSize() - (virtualItems.at(-1)?.end ?? 0),
                      }}
                    />
                  </tr>
                )}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground/60">
          <span>
            Page {meta.page} of {totalPages} ({meta.total} total)
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="border-white/[0.08]"
              onClick={handlePrevPage}
              disabled={meta.page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="border-white/[0.08]"
              onClick={handleNextPage}
              disabled={meta.page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
