import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { listExecutions, createExecution } from '@/lib/services/execution-service';
import { enqueueExecution } from '@/lib/worker/queue';
import type { ExecutionStatus } from '@/lib/types';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const result = await listExecutions({
    taskId: url.searchParams.get('taskId') ?? undefined,
    agentId: url.searchParams.get('agentId') ?? undefined,
    status: (url.searchParams.get('status') as ExecutionStatus) ?? undefined,
    page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
    pageSize: url.searchParams.has('pageSize')
      ? Number(url.searchParams.get('pageSize'))
      : undefined,
  });
  return NextResponse.json({
    data: result.data,
    meta: { total: result.total, page: result.page, pageSize: result.pageSize },
  });
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const execution = await createExecution(body);

  await enqueueExecution({
    executionId: execution.id,
    capabilityId: execution.capabilityId,
    agentId: execution.agentId,
    args: execution.args,
  });

  return NextResponse.json({ data: execution }, { status: 201 });
});
