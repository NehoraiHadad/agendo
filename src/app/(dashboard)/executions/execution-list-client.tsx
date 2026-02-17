'use client';

import { ExecutionTable } from '@/components/executions/execution-table';
import type { Execution } from '@/lib/types';

interface ExecutionListClientProps {
  initialData: Execution[];
  initialMeta: { total: number; page: number; pageSize: number };
}

export function ExecutionListClient({ initialData, initialMeta }: ExecutionListClientProps) {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Executions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          View and manage agent execution history.
        </p>
      </div>

      <ExecutionTable initialData={initialData} initialMeta={initialMeta} />
    </div>
  );
}
