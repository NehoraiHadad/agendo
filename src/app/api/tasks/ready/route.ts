import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { listReadyTasks } from '@/lib/services/task-service';

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const projectId = new URL(req.url).searchParams.get('projectId') ?? undefined;
  const readyTasks = await listReadyTasks(projectId);
  return NextResponse.json({ data: readyTasks });
});
