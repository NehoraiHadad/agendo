import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { createBrainstorm, listBrainstorms } from '@/lib/services/brainstorm-service';
import type { BrainstormStatus } from '@/lib/types';

const VALID_STATUSES = ['waiting', 'active', 'paused', 'synthesizing', 'ended'] as const;

const createBrainstormSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  title: z.string().min(1),
  topic: z.string().min(1),
  maxWaves: z.number().int().min(1).max(100).optional(),
  diagnosis: z.string().optional(),
  participants: z
    .array(
      z.object({
        agentId: z.string().uuid(),
        model: z.string().optional(),
      }),
    )
    .min(2, 'At least 2 participants are required'),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? undefined;
  const statusParam = url.searchParams.get('status');
  const status =
    statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as BrainstormStatus)
      : undefined;

  const rooms = await listBrainstorms({ projectId, status });
  return NextResponse.json({ data: rooms });
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = createBrainstormSchema.parse(await req.json());

  const room = await createBrainstorm({
    projectId: body.projectId,
    taskId: body.taskId,
    title: body.title,
    topic: body.topic,
    maxWaves: body.maxWaves,
    diagnosis: body.diagnosis,
    participants: body.participants,
  });

  return NextResponse.json({ data: { id: room.id } }, { status: 201 });
});
