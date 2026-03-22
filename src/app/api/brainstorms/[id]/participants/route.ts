import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary, assertUUID } from '@/lib/api-handler';
import { isBrainstormOrchestratorLive } from '@/lib/brainstorm/orchestrator-liveness';
import { addParticipant, removeParticipant } from '@/lib/services/brainstorm-service';
import { sendBrainstormControl } from '@/lib/realtime/worker-client';

const addParticipantSchema = z.object({
  agentId: z.string().uuid(),
  model: z.string().optional(),
});

const removeParticipantSchema = z.object({
  participantId: z.string().uuid(),
});

export const POST = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = addParticipantSchema.parse(await req.json());

    // Service validates room status, agent existence, and locks the room row
    const participant = await addParticipant(id, body.agentId, body.model);

    // Notify the orchestrator so it can hot-add the participant's session
    if (await isBrainstormOrchestratorLive(id)) {
      await sendBrainstormControl(id, {
        type: 'add-participant',
        agentId: body.agentId,
        participantId: participant.id,
      });
    }

    return NextResponse.json({ data: participant }, { status: 201 });
  },
);

export const DELETE = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<Record<string, string>> }) => {
    const { id } = await params;
    assertUUID(id, 'BrainstormRoom');

    const body = removeParticipantSchema.parse(await req.json());

    // Service validates room status and targets exactly one participant slot
    await removeParticipant(id, body.participantId);

    if (await isBrainstormOrchestratorLive(id)) {
      await sendBrainstormControl(id, {
        type: 'remove-participant',
        participantId: body.participantId,
      });
    }

    // 204 No Content — body must be empty per HTTP spec
    return new NextResponse(null, { status: 204 });
  },
);
