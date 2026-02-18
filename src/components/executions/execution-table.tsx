'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { apiFetch, type ApiListResponse } from '@/lib/api-types';
import { ExecutionRow } from './execution-row';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Execution, ExecutionStatus } from '@/lib/types';

const ALL_STATUSES: ExecutionStatus[] = [
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
];

interface ExecutionTableProps {
  initialData?: Execution[];
  initialMeta?: { total: number; page: number; pageSize: number };
}

export function ExecutionTable({ initialData, initialMeta }: ExecutionTableProps) {
  const [data, setData] = useState<Execution[]>(initialData ?? []);
  const [meta, setMeta] = useState(initialMeta ?? { total: 0, page: 1, pageSize: 20 });
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 56,
    overscan: 20,
  });

  const fetchExecutions = useCallback(
    async (page: number, status: string) => {
      setIsLoading(true);
      try {
        const params = new URLSearchParams();
        if (status !== 'all') params.set('status', status);
        params.set('page', String(page));
        params.set('pageSize', String(meta.pageSize));

        const result = await apiFetch<ApiListResponse<Execution>>(
          `/api/executions?${params.toString()}`,
        );
        setData(result.data);
        setMeta(result.meta);
      } finally {
        setIsLoading(false);
      }
    },
    [meta.pageSize],
  );

  useEffect(() => {
    if (!initialData) {
      fetchExecutions(1, statusFilter);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStatusChange = (value: string) => {
    setStatusFilter(value);
    fetchExecutions(1, value);
  };

  const handlePrevPage = () => {
    if (meta.page > 1) fetchExecutions(meta.page - 1, statusFilter);
  };

  const handleNextPage = () => {
    const totalPages = Math.ceil(meta.total / meta.pageSize);
    if (meta.page < totalPages) fetchExecutions(meta.page + 1, statusFilter);
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
              <TableHead className="w-[100px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">ID</TableHead>
              <TableHead className="w-[120px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">Status</TableHead>
              <TableHead className="w-[120px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">Duration</TableHead>
              <TableHead className="w-[80px] text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">Exit Code</TableHead>
              <TableHead className="w-[80px] text-right text-[10px] uppercase tracking-widest text-muted-foreground/60 font-medium h-9">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.length === 0 ? (
              <TableRow>
                <TableHead colSpan={5} className="h-24 text-center">
                  No executions found.
                </TableHead>
              </TableRow>
            ) : (
              <>
                {virtualItems[0]?.start > 0 && (
                  <tr>
                    <td colSpan={5} style={{ height: virtualItems[0].start }} />
                  </tr>
                )}
                {virtualItems.map((virtualRow) => (
                  <ExecutionRow
                    key={data[virtualRow.index].id}
                    execution={data[virtualRow.index]}
                    onCancelled={() => fetchExecutions(meta.page, statusFilter)}
                  />
                ))}
                {virtualItems.length > 0 && (
                  <tr>
                    <td
                      colSpan={5}
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
