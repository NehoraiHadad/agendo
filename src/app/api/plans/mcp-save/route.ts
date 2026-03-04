import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { savePlanFromMcp } from '@/lib/services/plan-service';

const savePlanSchema = z.object({
  content: z.string().min(1),
  title: z.string().max(500).optional(),
  planId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
});

export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = savePlanSchema.parse(await req.json());
  const result = await savePlanFromMcp(body.sessionId, body.content, body.title, body.planId);
  return NextResponse.json({ data: result });
});
