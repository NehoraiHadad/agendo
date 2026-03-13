import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm, addMessage } from '@/lib/services/brainstorm-service';
import { publish, channelName } from '@/lib/realtime/pg-notify';
import { enqueueBrainstorm } from '@/lib/worker/brainstorm-queue';

const steerSchema = z.object({
  text: z.string().min(1),
});

/** Emit an immediate SSE event so the UI shows the user's message without waiting for the orchestrator. */
async function emitUserMessageEvent(roomId: string, wave: number, text: string): Promise<void> {
  await publish(channelName('brainstorm_events', roomId), {
    type: 'message',
    wave,
    senderType: 'user',
    agentId: undefined,
    agentName: undefined,
    content: text,
    isPass: false,
    id: Date.now(),
    ts: Date.now(),
  });
}

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = steerSchema.parse(await req.json());

    const room = await getBrainstorm(id);

    if (room.status === 'paused') {
      // Room is paused — orchestrator has exited. Re-enqueue it first so we
      // know whether it was alive before deciding how to persist the message.
      const jobId = await enqueueBrainstorm({ roomId: id });
      if (jobId) {
        // Orchestrator was dead — persist message so the resumed orchestrator
        // finds it in DB. addMessage only here to avoid duplicate writes.
        await addMessage({
          roomId: id,
          wave: room.currentWave + 1,
          senderType: 'user',
          content: body.text,
        });
        // Emit immediate SSE so the user sees their message without waiting.
        await emitUserMessageEvent(id, room.currentWave + 1, body.text);
        return NextResponse.json({ data: { sent: true, resumed: true } });
      }
      // Orchestrator IS alive (singletonKey conflict) — fall through to PG NOTIFY.
      // The orchestrator will persist the message itself when processing the steer.
    }

    // Orchestrator is alive — send control signal via PG NOTIFY.
    // Do NOT persist here; the orchestrator is the sole DB writer for messages.
    await publish(channelName('brainstorm_control', id), {
      type: 'steer',
      text: body.text,
    });
    // Emit immediate SSE so the user sees their message right away rather than
    // waiting for the orchestrator to start the next wave.
    await emitUserMessageEvent(id, room.currentWave + 1, body.text);

    return NextResponse.json({ data: { sent: true } });
  },
);
