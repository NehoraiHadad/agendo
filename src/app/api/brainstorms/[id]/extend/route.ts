import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import {
  extendBrainstorm,
  getBrainstorm,
  updateBrainstormMaxWaves,
} from '@/lib/services/brainstorm-service';
import { enqueueBrainstorm } from '@/lib/worker/brainstorm-queue';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { ConflictError } from '@/lib/errors';

const extendSchema = z.object({
  /** Number of additional waves to add (default 5, max 20). */
  additionalWaves: z.number().int().min(1).max(20).optional().default(5),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = extendSchema.parse(await req.json().catch(() => ({})));
    const room = await getBrainstorm(id);

    if (room.status === 'paused') {
      // Orchestrator is alive and waiting — update maxWaves in DB and send
      // an extend control message so the orchestrator picks up the new limit
      // and resumes the wave loop.
      const updated = await updateBrainstormMaxWaves(id, room.maxWaves + body.additionalWaves);
      await publish(channelName('brainstorm_control', id), {
        type: 'extend',
        additionalWaves: body.additionalWaves,
      });
      return NextResponse.json({ data: updated });
    }

    if (room.status === 'ended') {
      // No orchestrator running — use the full extend flow that sets
      // status='waiting' and re-enqueues a new orchestrator job.
      const updated = await extendBrainstorm(id, body.additionalWaves);
      await enqueueBrainstorm({ roomId: id });
      return NextResponse.json({ data: updated });
    }

    throw new ConflictError(
      `Cannot extend a brainstorm room with status '${room.status}'. Only 'paused' or 'ended' rooms can be extended.`,
    );
  },
);
