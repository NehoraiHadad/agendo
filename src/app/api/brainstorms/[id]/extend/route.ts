import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { extendBrainstorm } from '@/lib/services/brainstorm-service';
import { enqueueBrainstorm } from '@/lib/worker/brainstorm-queue';

const extendSchema = z.object({
  /** Number of additional waves to add (default 5, max 20). */
  additionalWaves: z.number().int().min(1).max(20).optional().default(5),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = extendSchema.parse(await req.json().catch(() => ({})));

    // Validate status and update maxWaves + status='waiting' atomically
    const room = await extendBrainstorm(id, body.additionalWaves);

    // Enqueue the orchestrator job (singletonKey prevents duplicates)
    await enqueueBrainstorm({ roomId: id });

    return NextResponse.json({ data: room });
  },
);
