import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { listSubtasks } from '@/lib/services/task-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Task');
    const subtasks = await listSubtasks(id);
    return NextResponse.json({ data: subtasks });
  },
);
