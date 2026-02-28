import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { startPlanConversation, getPlan } from '@/lib/services/plan-service';

const startSchema = z.object({
  agentId: z.string().uuid(),
  capabilityId: z.string().uuid(),
  model: z.string().optional(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');
    const body = startSchema.parse(await req.json());
    const result = await startPlanConversation(id, body);
    return NextResponse.json({ data: result }, { status: 201 });
  },
);

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');
    const plan = await getPlan(id);
    if (!plan.conversationSessionId) {
      return NextResponse.json({ data: null });
    }
    return NextResponse.json({ data: { sessionId: plan.conversationSessionId } });
  },
);
