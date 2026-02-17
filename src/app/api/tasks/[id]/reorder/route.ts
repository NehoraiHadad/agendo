import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { reorderTask } from '@/lib/services/task-service';

const reorderSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
  afterSortOrder: z.number().nullable(),
  beforeSortOrder: z.number().nullable(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = reorderSchema.parse(await req.json());

    const task = await reorderTask(id, {
      status: body.status,
      afterSortOrder: body.afterSortOrder,
      beforeSortOrder: body.beforeSortOrder,
    });

    return NextResponse.json({ data: task });
  },
);
