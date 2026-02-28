import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { resumeFromSnapshot } from '@/lib/services/snapshot-service';

const resumeSchema = z.object({
  agentId: z.string().uuid(),
  capabilityId: z.string().uuid(),
  permissionMode: z
    .enum(['default', 'bypassPermissions', 'acceptEdits', 'plan', 'dontAsk'])
    .optional(),
  additionalContext: z.string().optional(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'ContextSnapshot');

    const body = resumeSchema.parse(await req.json());
    const result = await resumeFromSnapshot(id, body);
    return NextResponse.json({ data: result }, { status: 201 });
  },
);
