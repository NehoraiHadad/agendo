import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { sendBrainstormControl, sendBrainstormEvent } from '@/lib/realtime/worker-client';
import { enqueueBrainstorm } from '@/lib/worker/brainstorm-queue';
import { FileLogWriter } from '@/lib/worker/log-writer';

const steerSchema = z.object({
  text: z.string().min(1),
});

/** Emit an immediate SSE event so the UI shows the user's message without waiting for the orchestrator. */
async function emitUserMessageEvent(roomId: string, wave: number, text: string): Promise<void> {
  await sendBrainstormEvent(roomId, {
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

/**
 * Write a user steer message directly to the brainstorm log file.
 * Used when the orchestrator is dead (room paused) so it picks up the message
 * from the log on resume instead of a DB query.
 *
 * Uses `Date.now()` as the event id since no orchestrator is running to
 * provide a monotonic sequence. The orchestrator's own eventSeq will resume
 * from its counter on restart, and the reset-detection in
 * readBrainstormEventsFromLog handles any id ordering gaps.
 */
async function writeSteerToLog(
  logFilePath: string,
  roomId: string,
  wave: number,
  text: string,
): Promise<void> {
  const writer = new FileLogWriter(logFilePath);
  writer.open();
  writer.writeEvent({
    id: Date.now(),
    roomId,
    ts: Date.now(),
    type: 'message',
    wave,
    senderType: 'user',
    agentId: undefined,
    agentName: undefined,
    content: text,
    isPass: false,
  });
  await writer.close();
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
        // Orchestrator was dead — persist the steer message to the log file
        // so the resumed orchestrator finds it on startup.
        if (room.logFilePath) {
          await writeSteerToLog(room.logFilePath, id, room.currentWave + 1, body.text);
        }
        // Emit immediate SSE so the user sees their message without waiting.
        await emitUserMessageEvent(id, room.currentWave + 1, body.text);
        return NextResponse.json({ data: { sent: true, resumed: true } });
      }
      // Orchestrator IS alive (singletonKey conflict) — fall through to PG NOTIFY.
      // The orchestrator will write the message to the log via emitEvent().
    }

    // Orchestrator is alive — send control signal via PG NOTIFY.
    // Do NOT write to log here; the orchestrator is the sole log writer for live events.
    await sendBrainstormControl(id, {
      type: 'steer',
      text: body.text,
    });
    // Emit immediate SSE so the user sees their message right away rather than
    // waiting for the orchestrator to start the next wave.
    await emitUserMessageEvent(id, room.currentWave + 1, body.text);

    return NextResponse.json({ data: { sent: true } });
  },
);
