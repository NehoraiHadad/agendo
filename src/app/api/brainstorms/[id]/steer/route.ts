import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm, addMessage } from '@/lib/services/brainstorm-service';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { enqueueBrainstorm } from '@/lib/worker/brainstorm-queue';

const steerSchema = z.object({
  text: z.string().min(1),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = steerSchema.parse(await req.json());

    const room = await getBrainstorm(id);

    if (room.status === 'paused') {
      // Room is paused (converged or max-waves) and the orchestrator likely
      // exited (worker restart, timeout, etc.). Persist the steer message to
      // DB so the orchestrator can pick it up on resume, then re-enqueue.
      await addMessage({
        roomId: id,
        wave: room.currentWave + 1,
        senderType: 'user',
        content: body.text,
      });

      // Re-enqueue the orchestrator — singletonKey prevents duplicates if
      // the orchestrator is somehow still alive.
      const jobId = await enqueueBrainstorm({ roomId: id });
      if (jobId) {
        return NextResponse.json({ data: { sent: true, resumed: true } });
      }

      // If enqueue failed (singletonKey = active job exists), the orchestrator
      // IS alive and listening. Fall through to PG NOTIFY.
    }

    // Orchestrator is alive — send control signal via PG NOTIFY.
    // Do NOT persist the message here — the orchestrator is the sole
    // writer for brainstorm messages. Persisting in both places causes
    // duplicate messages on SSE reconnect replay.
    await publish(channelName('brainstorm_control', id), {
      type: 'steer',
      text: body.text,
    });

    return NextResponse.json({ data: { sent: true } });
  },
);
