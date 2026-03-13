import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { ConflictError } from '@/lib/errors';

const endSchema = z.object({
  synthesize: z.boolean().optional().default(false),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = endSchema.parse(await req.json());

    // Verify the room exists and is in an endable state
    const room = await getBrainstorm(id);
    if (room.status === 'ended') {
      throw new ConflictError('BrainstormRoom is already ended');
    }

    // Do NOT update status here — the orchestrator is the single writer
    // for room status. Setting it prematurely causes conflicts if publish fails.
    // Signal the orchestrator to wrap up (and optionally synthesize)
    await publish(channelName('brainstorm_control', id), {
      type: 'end',
      synthesize: body.synthesize,
    });

    return NextResponse.json({ data: { ended: true } });
  },
);
