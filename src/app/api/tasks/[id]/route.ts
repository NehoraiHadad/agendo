import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { getTaskWithDetails, updateTask, deleteTask } from '@/lib/services/task-service';
import { taskStatusEnum } from '@/lib/db/schema';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const task = await getTaskWithDetails(id);
    return NextResponse.json({ data: task });
  },
);

const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  status: z.enum(taskStatusEnum.enumValues).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  dueAt: z.coerce.date().nullable().optional(),
});

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    const body = await req.json();
    const validated = patchSchema.parse(body);
    const task = await updateTask(id, validated);
    return NextResponse.json({ data: task });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    await deleteTask(id);
    return NextResponse.json({ data: null }, { status: 200 });
  },
);
