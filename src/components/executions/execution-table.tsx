'use client';

import { useState, useEffect, useCallback } from 'react';
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-[160px]">
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

        {isLoading && <span className="text-sm text-muted-foreground">Loading...</span>}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">ID</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead className="w-[120px]">Duration</TableHead>
              <TableHead className="w-[80px]">Exit Code</TableHead>
              <TableHead className="w-[80px] text-right">Actions</TableHead>
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
              data.map((execution) => (
                <ExecutionRow
                  key={execution.id}
                  execution={execution}
                  onCancelled={() => fetchExecutions(meta.page, statusFilter)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {meta.page} of {totalPages} ({meta.total} total)
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={handlePrevPage}
              disabled={meta.page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
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
