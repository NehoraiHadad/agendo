import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { enqueueBrainstorm } from '@/lib/worker/brainstorm-queue';
import { ConflictError } from '@/lib/errors';

export const POST = withErrorBoundary(
  async (_req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const room = await getBrainstorm(id);

    const startableStatuses = ['waiting', 'ended', 'paused'];
    if (!startableStatuses.includes(room.status)) {
      throw new ConflictError(
        `Cannot start a brainstorm room with status '${room.status}'. Only ${startableStatuses.join(', ')} rooms can be started.`,
      );
    }

    // Do NOT set status here — the orchestrator sets 'active' atomically
    // when it starts processing. Setting it prematurely causes stuck rooms
    // if the enqueue fails.
    await enqueueBrainstorm({ roomId: id });

    return NextResponse.json({ data: { started: true } });
  },
);
