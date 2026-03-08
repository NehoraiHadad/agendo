import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { forkSessionToAgent } from '@/lib/services/session-fork-service';

const forkToAgentSchema = z.object({
  agentId: z.string().uuid(),
  capabilityId: z.string().uuid().optional(),
  contextMode: z.enum(['hybrid', 'full']).default('hybrid'),
  additionalInstructions: z.string().max(2000).optional(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'Session');

    const body = forkToAgentSchema.parse(await req.json());

    const result = await forkSessionToAgent({
      parentSessionId: id,
      newAgentId: body.agentId,
      capabilityId: body.capabilityId,
      contextMode: body.contextMode,
      additionalInstructions: body.additionalInstructions,
    });

    return NextResponse.json(
      {
        data: {
          sessionId: result.session.id,
          agentId: body.agentId,
          agentName: result.agentName,
          contextMeta: result.contextMeta,
        },
      },
      { status: 201 },
    );
  },
);
