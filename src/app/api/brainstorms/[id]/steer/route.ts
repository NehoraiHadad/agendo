import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { publish, channelName } from '@/lib/realtime/pg-notify';

const steerSchema = z.object({
  text: z.string().min(1),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = steerSchema.parse(await req.json());

    // Verify the room exists
    await getBrainstorm(id);

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
