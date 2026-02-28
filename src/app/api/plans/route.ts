import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { createPlan, listPlans } from '@/lib/services/plan-service';
import type { PlanStatus } from '@/lib/types';

const VALID_STATUSES = ['draft', 'ready', 'stale', 'executing', 'done', 'archived'] as const;

const createPlanSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  sourceSessionId: z.string().uuid().optional(),
  metadata: z
    .object({
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
    })
    .optional(),
});

export const GET = withErrorBoundary(async (req: NextRequest) => {
  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId') ?? undefined;
  const statusParam = url.searchParams.get('status');
  const limitParam = url.searchParams.get('limit');

  const status =
    statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as PlanStatus)
      : undefined;

  const limit = limitParam ? Number(limitParam) : undefined;

  const data = await listPlans({ projectId, status, limit });
  return NextResponse.json({ data });
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = createPlanSchema.parse(await req.json());
  const plan = await createPlan(body);
  return NextResponse.json({ data: plan }, { status: 201 });
});
