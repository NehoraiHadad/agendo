import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { setExecutionOrder } from '@/lib/services/task-service';

const schema = z.object({
  taskIds: z.array(z.string().uuid()).min(1),
});

export const PUT = withErrorBoundary(async (req: NextRequest) => {
  const body = await req.json();
  const { taskIds } = schema.parse(body);
  await setExecutionOrder({ taskIds });
  return NextResponse.json({ data: { updated: taskIds.length } });
});
