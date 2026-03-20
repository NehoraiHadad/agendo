import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { createBrainstorm, listBrainstorms } from '@/lib/services/brainstorm-service';
import type { BrainstormStatus } from '@/lib/types';
import { createBrainstormRequestSchema } from '@/lib/brainstorm/config-schema';

const VALID_STATUSES = ['waiting', 'active', 'paused', 'synthesizing', 'ended'] as const;

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
  const body = createBrainstormRequestSchema.parse(await req.json());

  const room = await createBrainstorm({
    projectId: body.projectId,
    taskId: body.taskId,
    title: body.title,
    topic: body.topic,
    maxWaves: body.maxWaves,
    config: body.config,
    participants: body.participants,
  });

  return NextResponse.json({ data: { id: room.id } }, { status: 201 });
});
