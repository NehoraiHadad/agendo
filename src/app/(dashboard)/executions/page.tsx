export const dynamic = 'force-dynamic';

import { listExecutions } from '@/lib/services/execution-service';
import { ExecutionListClient } from './execution-list-client';
import type { ExecutionStatus } from '@/lib/types';

interface ExecutionsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ExecutionsPage({ searchParams }: ExecutionsPageProps) {
  const params = await searchParams;
  const status = typeof params.status === 'string' ? (params.status as ExecutionStatus) : undefined;
  const page = typeof params.page === 'string' ? Number(params.page) : 1;

  const result = await listExecutions({ status, page, pageSize: 20 });

  return (
    <ExecutionListClient
      initialData={result.data}
      initialMeta={{
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      }}
    />
  );
}
