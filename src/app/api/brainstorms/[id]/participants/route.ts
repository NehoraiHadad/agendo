import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { isBrainstormOrchestratorLive } from '@/lib/brainstorm/orchestrator-liveness';
import {
  getBrainstorm,
  addParticipant,
  removeParticipant,
} from '@/lib/services/brainstorm-service';
import { sendBrainstormControl } from '@/lib/realtime/worker-client';
import { ConflictError } from '@/lib/errors';

const MUTABLE_STATUSES = ['waiting', 'active', 'paused'] as const;

const addParticipantSchema = z.object({
  agentId: z.string().uuid(),
  model: z.string().optional(),
});

const removeParticipantSchema = z.object({
  agentId: z.string().uuid(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = addParticipantSchema.parse(await req.json());

    const room = await getBrainstorm(id);
    if (!(MUTABLE_STATUSES as readonly string[]).includes(room.status)) {
      throw new ConflictError(
        `Cannot add participants to a brainstorm room with status '${room.status}'.`,
      );
    }

    const participant = await addParticipant(id, body.agentId, body.model);
    return NextResponse.json({ data: participant }, { status: 201 });
  },
);

export const DELETE = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = removeParticipantSchema.parse(await req.json());

    // Soft-remove: set status to 'left'
    await removeParticipant(id, body.agentId);

    if (await isBrainstormOrchestratorLive(id)) {
      await sendBrainstormControl(id, {
        type: 'remove-participant',
        agentId: body.agentId,
      });
    }

    // 204 No Content — body must be empty per HTTP spec
    return new NextResponse(null, { status: 204 });
  },
);
