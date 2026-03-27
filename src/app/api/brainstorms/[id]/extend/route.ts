import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import {
  addWaveBudget,
  extendBrainstorm,
  getBrainstorm,
  updateBrainstormMaxWaves,
  updateBrainstormStatus,
} from '@/lib/services/brainstorm-service';
import { isBrainstormOrchestratorLive } from '@/lib/brainstorm/orchestrator-liveness';
import { dispatchBrainstorm } from '@/lib/services/brainstorm-dispatch';
import { sendBrainstormControl } from '@/lib/realtime/worker-client';
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
      if (await isBrainstormOrchestratorLive(id)) {
        await sendBrainstormControl(id, {
          type: 'extend',
          additionalWaves: body.additionalWaves,
        });
        const updated = await updateBrainstormMaxWaves(id, room.maxWaves + body.additionalWaves);
        return NextResponse.json({ data: updated });
      }

      // No live orchestrator — bump wave budget, reset status, and re-enqueue.
      await addWaveBudget(id, body.additionalWaves);
      const updated = await updateBrainstormStatus(id, 'waiting');
      await dispatchBrainstorm(id);
      return NextResponse.json({ data: updated });
    }

    if (room.status === 'ended') {
      // No orchestrator running — use the full extend flow that sets
      // status='waiting' and re-enqueues a new orchestrator job.
      const updated = await extendBrainstorm(id, body.additionalWaves);
      await dispatchBrainstorm(id);
      return NextResponse.json({ data: updated });
    }

    throw new ConflictError(
      `Cannot extend a brainstorm room with status '${room.status}'. Only 'paused' or 'ended' rooms can be extended.`,
    );
  },
);
