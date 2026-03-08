import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { listPlanVersions, savePlanContent } from '@/lib/services/plan-service';

export const GET = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');

    const versions = await listPlanVersions(id);
    return NextResponse.json({ data: versions });
  },
);

const createVersionSchema = z.object({
  content: z.string().min(1),
  metadata: z
    .object({
      source: z.enum(['exitPlanMode', 'manual_edit', 'conversation', 'mcp']).optional(),
      sessionId: z.string().uuid().optional(),
      agentId: z.string().uuid().optional(),
    })
    .optional(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Plan');

    const body = createVersionSchema.parse(await req.json());
    const version = await savePlanContent(
      id,
      body.content,
      body.metadata ?? { source: 'manual_edit' },
    );

    if (!version) {
      return NextResponse.json({ data: null, message: 'Content identical to latest version' });
    }
    return NextResponse.json({ data: version }, { status: 201 });
  },
);
