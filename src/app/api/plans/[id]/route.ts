import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getPlan, updatePlan, archivePlan } from '@/lib/services/plan-service';

const patchPlanSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.string().min(1).optional(),
  status: z.enum(['draft', 'ready', 'stale', 'executing', 'done', 'archived']).optional(),
  metadata: z
    .object({
      tags: z.array(z.string()).optional(),
      notes: z.string().optional(),
    })
    .optional(),
});

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');

    const plan = await getPlan(id);
    return NextResponse.json({ data: plan });
  },
);

export const PATCH = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');

    const body = patchPlanSchema.parse(await req.json());
    const updated = await updatePlan(id, body);
    return NextResponse.json({ data: updated });
  },
);

export const DELETE = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');

    await archivePlan(id);
    return NextResponse.json({ data: { id } });
  },
);
