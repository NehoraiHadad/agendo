import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { validatePlan } from '@/lib/services/plan-service';

const validatePlanSchema = z.object({
  agentId: z.string().uuid(),
  capabilityId: z.string().uuid(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');

    const body = validatePlanSchema.parse(await req.json());
    const result = await validatePlan(id, body);
    return NextResponse.json({ data: result }, { status: 201 });
  },
);
