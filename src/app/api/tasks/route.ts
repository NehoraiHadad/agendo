import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { QueryParams } from '@/lib/query-params';
import { createTask, listTasksByStatus } from '@/lib/services/task-service';
import { taskStatusEnum } from '@/lib/db/schema';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const qp = new QueryParams(req);
  const status = qp.getEnum('status', taskStatusEnum.enumValues);
  const cursor = qp.getString('cursor');
  const limit = qp.getNumber('limit', 50) ?? 50;
  const parentTaskId = qp.getString('parentTaskId');
  const q = qp.getString('q');
  const projectId = qp.getString('projectId');

  const result = await listTasksByStatus({
    status,
    cursor,
    limit,
    parentTaskId,
    q,
    projectId,
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
  projectId: z.string().uuid().optional(),
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const validated = createSchema.parse(body);
  const task = await createTask(validated);

  return NextResponse.json({ data: task }, { status: 201 });
});
