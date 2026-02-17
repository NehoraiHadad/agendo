import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { createTask, listTasksByStatus } from '@/lib/services/task-service';
import { checkTaskCreationRateLimit } from '@/lib/services/loop-prevention';
import { taskStatusEnum } from '@/lib/db/schema';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const status = url.searchParams.get('status') as
    | (typeof taskStatusEnum.enumValues)[number]
    | null;
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 50;
  const parentTaskId = url.searchParams.get('parentTaskId') ?? undefined;

  const result = await listTasksByStatus({
    status: status ?? undefined,
    cursor,
    limit,
    parentTaskId,
  });

  return NextResponse.json({
    data: result.tasks,
    meta: { nextCursor: result.nextCursor },
  });
});

const createSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  parentTaskId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  dueAt: z.coerce.date().optional(),
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const agentId = req.headers.get('x-agent-id');
  if (agentId?.startsWith('mcp-')) {
    await checkTaskCreationRateLimit(agentId);
  }

  const body = await req.json();
  const validated = createSchema.parse(body);
  const task = await createTask(validated);

  return NextResponse.json({ data: task }, { status: 201 });
});
