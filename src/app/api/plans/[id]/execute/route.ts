import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { executePlan } from '@/lib/services/plan-service';

const executePlanSchema = z.object({
  agentId: z.string().uuid(),
  capabilityId: z.string().uuid(),
  model: z.string().optional(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');

    const body = executePlanSchema.parse(await req.json());
    const result = await executePlan(id, body);
    return NextResponse.json({ data: result }, { status: 201 });
  },
);
