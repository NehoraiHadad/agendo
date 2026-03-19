'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatDistanceStrict, formatDistanceToNow } from 'date-fns';
import {
  Activity,
  MessageSquare,
  MinusCircle,
  Pause,
  Play,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { apiFetch, type ApiListResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Session, SessionStatus } from '@/lib/types';
import { getErrorMessage } from '@/lib/utils/error-utils';

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
// KindBadge
// ---------------------------------------------------------------------------

function KindBadge({ kind }: { kind: string }) {
  if (kind !== 'execution') return null;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60">
      <Play className="size-3" />
      Exec
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
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

function isDeletable(status: SessionStatus): boolean {
  return status === 'ended' || status === 'idle';
}

// ---------------------------------------------------------------------------
// SessionRow
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: SessionWithDetails;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onDeleteOne: (session: SessionWithDetails) => void;
}

function SessionRow({ session, selected, onSelect, onDeleteOne }: SessionRowProps) {
  const canDelete = isDeletable(session.status);
  return (
    <TableRow className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors group">
      <TableCell className="w-10 pr-0">
        <Checkbox
          checked={selected}
          onCheckedChange={(v) => onSelect(session.id, !!v)}
          disabled={!canDelete}
          aria-label={`Select session ${session.id.slice(0, 8)}`}
        />
      </TableCell>
      <TableCell className="font-mono text-xs">
        <Link
          href={`/sessions/${session.id}`}
          className="font-mono text-xs text-muted-foreground/70 hover:text-primary transition-colors no-underline hover:no-underline"
        >
          {session.title ? (
            <span className="text-foreground/80 font-sans font-medium">{session.title}</span>
          ) : (
            session.id.slice(0, 8)
          )}
        </Link>
      </TableCell>
      <TableCell>
        <SessionStatusBadge status={session.status} />
      </TableCell>
      <TableCell>
        <KindBadge kind={session.kind} />
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
      <TableCell className="w-10 pl-0">
        {canDelete && (
          <button
            onClick={() => onDeleteOne(session)}
            className="rounded-md p-1.5 text-muted-foreground/40 hover:text-destructive hover:bg-white/[0.06] transition-colors opacity-0 group-hover:opacity-100"
            aria-label="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// SessionCard — mobile card layout
// ---------------------------------------------------------------------------

interface SessionCardProps {
  session: SessionWithDetails;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
  onDeleteOne: (session: SessionWithDetails) => void;
}

function SessionCard({ session, selected, onSelect, onDeleteOne }: SessionCardProps) {
  const canDelete = isDeletable(session.status);
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 hover:border-white/[0.12] hover:bg-white/[0.04] transition-colors">
      <div className="flex items-start gap-3 mb-2">
        {canDelete && (
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect(session.id, !!v)}
            className="mt-0.5 shrink-0"
            aria-label={`Select session ${session.id.slice(0, 8)}`}
          />
        )}
        <Link href={`/sessions/${session.id}`} className="min-w-0 flex-1 no-underline">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              {session.title ? (
                <p className="text-sm font-medium text-foreground/90 truncate">{session.title}</p>
              ) : (
                <p className="font-mono text-xs text-muted-foreground/70">
                  {session.id.slice(0, 8)}
                </p>
              )}
              {session.taskTitle && (
                <p className="mt-0.5 text-xs text-muted-foreground/60 truncate">
                  {session.taskTitle}
                </p>
              )}
            </div>
            <SessionStatusBadge status={session.status} className="shrink-0" />
          </div>
        </Link>
        {canDelete && (
          <button
            onClick={() => onDeleteOne(session)}
            className="shrink-0 rounded-md p-2.5 text-muted-foreground/40 hover:text-destructive hover:bg-white/[0.06] transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <Link href={`/sessions/${session.id}`} className="no-underline">
        <div className="flex items-center gap-3 text-xs text-muted-foreground/50 flex-wrap">
          <KindBadge kind={session.kind} />
          {session.agentName && <span>{session.agentName}</span>}
          <span>{session.totalTurns} turns</span>
          {session.totalCostUsd != null && (
            <span className="font-mono">${Number(session.totalCostUsd).toFixed(4)}</span>
          )}
          <span>{formatDuration(session.startedAt, session.endedAt)}</span>
          <span suppressHydrationWarning>
            {formatDistanceToNow(session.createdAt, { addSuffix: true })}
          </span>
        </div>
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionTable
// ---------------------------------------------------------------------------

const ALL_STATUSES: SessionStatus[] = ['active', 'awaiting_input', 'idle', 'ended'];
const COL_COUNT = 11; // checkbox + 9 data cols + delete

interface SessionTableProps {
  taskId?: string;
}

export function SessionTable({ taskId }: SessionTableProps) {
  const [data, setData] = useState<SessionWithDetails[]>([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pageSize: 20 });
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Delete confirmation dialog
  const [deleteTarget, setDeleteTarget] = useState<{ ids: string[]; label: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 56,
    overscan: 20,
  });

  const fetchSessions = useCallback(
    async (page: number, status: string, kind: string) => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams();
        if (status !== 'all') params.set('status', status);
        if (kind !== 'all') params.set('kind', kind);
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
    fetchSessions(1, statusFilter, kindFilter);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear selection when data changes
  useEffect(() => {
    setSelected(new Set());
  }, [data]);

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    fetchSessions(1, value, kindFilter);
  };

  const handleKindChange = (value: string) => {
    setKindFilter(value);
    fetchSessions(1, statusFilter, value);
  };

  const handlePrevPage = () => {
    if (meta.page > 1) fetchSessions(meta.page - 1, statusFilter, kindFilter);
  };

  const handleNextPage = () => {
    const totalPages = Math.ceil(meta.total / meta.pageSize);
    if (meta.page < totalPages) fetchSessions(meta.page + 1, statusFilter, kindFilter);
  };

  // Selection handlers
  const handleSelect = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const deletableIds = data.filter((s) => isDeletable(s.status)).map((s) => s.id);
  const allDeletableSelected =
    deletableIds.length > 0 && deletableIds.every((id) => selected.has(id));
  const someDeletableSelected = deletableIds.some((id) => selected.has(id));

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelected(new Set(deletableIds));
    } else {
      setSelected(new Set());
    }
  };

  // Delete handlers
  const handleDeleteOne = (session: SessionWithDetails) => {
    const label = session.title ?? session.id.slice(0, 8);
    setDeleteTarget({ ids: [session.id], label: `"${label}"` });
  };

  const handleDeleteSelected = () => {
    setDeleteTarget({
      ids: Array.from(selected),
      label: `${selected.size} session${selected.size > 1 ? 's' : ''}`,
    });
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      if (deleteTarget.ids.length === 1) {
        await apiFetch(`/api/sessions/${deleteTarget.ids[0]}`, { method: 'DELETE' });
        toast.success('Session deleted');
      } else {
        const result = await apiFetch<{ data: { deletedCount: number; skippedIds: string[] } }>(
          '/api/sessions',
          {
            method: 'DELETE',
            body: JSON.stringify({ sessionIds: deleteTarget.ids }),
          },
        );
        const { deletedCount, skippedIds } = result.data;
        if (skippedIds.length > 0) {
          toast.success(
            `Deleted ${deletedCount} session${deletedCount !== 1 ? 's' : ''} (${skippedIds.length} active skipped)`,
          );
        } else {
          toast.success(`Deleted ${deletedCount} session${deletedCount !== 1 ? 's' : ''}`);
        }
      }
      setDeleteTarget(null);
      setSelected(new Set());
      fetchSessions(meta.page, statusFilter, kindFilter);
    } catch (err) {
      toast.error(getErrorMessage(err));
    } finally {
      setIsDeleting(false);
    }
  };

  const totalPages = Math.ceil(meta.total / meta.pageSize);
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar: filters + bulk actions */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 mb-2">
        <div className="flex gap-2">
          <Select value={statusFilter} onValueChange={handleStatusChange}>
            <SelectTrigger className="flex-1 sm:w-[160px] border-white/[0.08] bg-white/[0.04]">
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

          <Select value={kindFilter} onValueChange={handleKindChange}>
            <SelectTrigger className="flex-1 sm:w-[160px] border-white/[0.08] bg-white/[0.04]">
              <SelectValue placeholder="Filter by kind" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              <SelectItem value="conversation">Conversations</SelectItem>
              <SelectItem value="execution">Executions</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading && <span className="text-sm text-muted-foreground/60">Loading...</span>}

        {/* Bulk delete bar */}
        {selected.size > 0 && (
          <div className="sm:ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground/70">{selected.size} selected</span>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteSelected}
              className="gap-1.5"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        )}
      </div>

      {/* Mobile card list (< sm) */}
      <div className="flex flex-col gap-2 sm:hidden">
        {!isLoading && data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground/50">No sessions found.</p>
        ) : (
          data.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              selected={selected.has(session.id)}
              onSelect={handleSelect}
              onDeleteOne={handleDeleteOne}
            />
          ))
        )}
      </div>

      {/* Desktop table (sm+) */}
      <div
        ref={scrollContainerRef}
        className="hidden sm:block rounded-xl border border-white/[0.06] overflow-hidden overflow-y-auto"
        style={{ maxHeight: '70vh' }}
      >
        <Table>
          <TableHeader className="bg-white/[0.02]">
            <TableRow>
              <TableHead className="w-10 pr-0 h-9">
                <Checkbox
                  checked={allDeletableSelected && deletableIds.length > 0}
                  onCheckedChange={(v) => handleSelectAll(!!v)}
                  aria-label="Select all deletable sessions"
                  {...(someDeletableSelected && !allDeletableSelected
                    ? { 'data-state': 'indeterminate' }
                    : {})}
                />
              </TableHead>
              <TableHead className="w-[100px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                ID
              </TableHead>
              <TableHead className="w-[130px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Status
              </TableHead>
              <TableHead className="w-[70px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">
                Kind
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
              <TableHead className="w-10 pl-0 h-9" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!isLoading && data.length === 0 ? (
              <TableRow>
                <TableHead colSpan={COL_COUNT} className="h-24 text-center">
                  No sessions found.
                </TableHead>
              </TableRow>
            ) : (
              <>
                {virtualItems[0]?.start > 0 && (
                  <tr>
                    <td colSpan={COL_COUNT} style={{ height: virtualItems[0].start }} />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => {
                  const session = data[virtualRow.index];
                  return (
                    <SessionRow
                      key={session.id}
                      session={session}
                      selected={selected.has(session.id)}
                      onSelect={handleSelect}
                      onDeleteOne={handleDeleteOne}
                    />
                  );
                })}
                {virtualItems.length > 0 && (
                  <tr>
                    <td
                      colSpan={COL_COUNT}
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

      {/* Delete confirmation dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove{' '}
              {deleteTarget?.ids.length === 1 ? 'this session' : 'these sessions'} and associated
              log files. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
