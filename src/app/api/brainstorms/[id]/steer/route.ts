import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm, extendBrainstorm } from '@/lib/services/brainstorm-service';
import { isBrainstormOrchestratorLive } from '@/lib/brainstorm/orchestrator-liveness';
import { sendBrainstormControl } from '@/lib/realtime/worker-client';
import { enqueueBrainstorm } from '@/lib/worker/brainstorm-queue';
import { FileLogWriter } from '@/lib/worker/log-writer';

const steerSchema = z.object({
  text: z.string().min(1),
});

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
  steerId: string,
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
    steerId,
  });
  await writer.close();
}

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = steerSchema.parse(await req.json());
    const steerId = randomUUID();

    const room = await getBrainstorm(id);

    // Room is dormant (paused/ended with no live orchestrator) — write the steer
    // to the log file so the new orchestrator picks it up on resume, then enqueue
    // a fresh orchestrator job to restart the room.
    const isDormant =
      (room.status === 'paused' || room.status === 'ended') &&
      !(await isBrainstormOrchestratorLive(id));

    if (isDormant) {
      if (room.logFilePath) {
        await writeSteerToLog(room.logFilePath, id, room.currentWave + 1, body.text, steerId);
      }
      // Ended rooms have exhausted their wave budget — extend with 5 extra waves
      // so the new orchestrator doesn't immediately hit max_waves and stop.
      // extendBrainstorm also transitions status to 'waiting' for a clean restart.
      if (room.status === 'ended') {
        await extendBrainstorm(id, 5);
      }
      await enqueueBrainstorm({ roomId: id });
      return NextResponse.json({ data: { sent: true, resumed: true, steerId } });
    }

    // Orchestrator is alive — send control signal via PG NOTIFY.
    // Do NOT write to log here; the orchestrator is the sole log writer for live events.
    // Do NOT emit SSE here; the orchestrator emits the user message when it processes the steer.
    await sendBrainstormControl(id, {
      type: 'steer',
      text: body.text,
      steerId,
    });

    return NextResponse.json({ data: { sent: true, steerId } });
  },
);
