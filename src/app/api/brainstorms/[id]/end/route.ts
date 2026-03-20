import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { isBrainstormOrchestratorLive } from '@/lib/brainstorm/orchestrator-liveness';
import { getBrainstorm, updateBrainstormStatus } from '@/lib/services/brainstorm-service';
import { sendBrainstormControl, sendBrainstormEvent } from '@/lib/realtime/worker-client';
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

    const orchestratorLive = await isBrainstormOrchestratorLive(id);

    if (orchestratorLive) {
      await sendBrainstormControl(id, {
        type: 'end',
        synthesize: body.synthesize,
      });
    }

    // Fallback: if the orchestrator is NOT running (e.g. worker restarted,
    // room was paused/waiting), the PG NOTIFY goes nowhere. Directly update
    // the DB status and emit a room:state event so the frontend reflects it.
    // For rooms with a live orchestrator this is a harmless idempotent write
    // (the orchestrator also sets status='ended' on its exit path).
    if (!orchestratorLive) {
      await updateBrainstormStatus(id, 'ended');
      await sendBrainstormEvent(id, {
        id: Date.now(),
        roomId: id,
        ts: Date.now(),
        type: 'room:state',
        status: 'ended',
      });
    }

    return NextResponse.json({ data: { ended: true } });
  },
);
