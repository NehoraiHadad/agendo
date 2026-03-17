import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { createBrainstorm, listBrainstorms } from '@/lib/services/brainstorm-service';
import type { BrainstormStatus } from '@/lib/types';

const VALID_STATUSES = ['waiting', 'active', 'paused', 'synthesizing', 'ended'] as const;

/** Zod schema for the Playbook config (BrainstormConfig) */
const brainstormConfigSchema = z
  .object({
    waveTimeoutSec: z.number().int().min(10).max(600).optional(),
    wave0ExtraTimeoutSec: z.number().int().min(0).max(600).optional(),
    convergenceMode: z.enum(['unanimous', 'majority']).optional(),
    minWavesBeforePass: z.number().int().min(0).max(50).optional(),
    requiredObjections: z.number().int().min(0).max(50).optional(),
    synthesisMode: z.enum(['single', 'validated']).optional(),
    synthesisAgentId: z.string().uuid().optional(),
    language: z.string().max(100).optional(),
    roles: z.record(z.string(), z.string()).optional(),
    participantReadyTimeoutSec: z.number().int().min(60).max(1800).optional(),
    relatedRoomIds: z.array(z.string().uuid()).max(3).optional(),
  })
  .optional();

const createBrainstormSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  title: z.string().min(1),
  topic: z.string().min(1),
  maxWaves: z.number().int().min(1).max(100).optional(),
  config: brainstormConfigSchema,
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
    config: body.config,
    participants: body.participants,
  });

  return NextResponse.json({ data: { id: room.id } }, { status: 201 });
});
