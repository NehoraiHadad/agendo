import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorBoundary } from '@/lib/api-handler';
import { getParticipantBySessionId } from '@/lib/services/brainstorm-service';
import { sendBrainstormControl } from '@/lib/realtime/worker-client';

const signalSchema = z.object({
  sessionId: z.string().uuid(),
  signal: z.enum(['done', 'pass', 'block']),
  reason: z.string().optional(),
});

/**
 * POST /api/brainstorms/signal
 *
 * Called by the MCP server's brainstorm_signal tool. Resolves the brainstorm
 * room from the session's linked participant, then forwards the signal to the
 * worker's orchestrator via brainstorm control.
 */
export const POST = withErrorBoundary(async (req: NextRequest) => {
  const body = signalSchema.parse(await req.json());

  // Require reason for pass and block
  if ((body.signal === 'pass' || body.signal === 'block') && !body.reason) {
    return NextResponse.json(
      { error: { message: `A reason is required when signaling '${body.signal}'` } },
      { status: 400 },
    );
  }

  // Find the brainstorm participant linked to this session
  const participant = await getParticipantBySessionId(body.sessionId);
  if (!participant) {
    return NextResponse.json(
      { error: { message: 'No brainstorm participant found for this session' } },
      { status: 404 },
    );
  }

  // Forward signal to the worker orchestrator
  const result = await sendBrainstormControl(participant.roomId, {
    type: 'signal',
    participantSessionId: body.sessionId,
    signal: body.signal,
    reason: body.reason,
  });

  return NextResponse.json({
    data: {
      dispatched: result.dispatched ?? false,
      roomId: participant.roomId,
      participantId: participant.id,
      signal: body.signal,
    },
  });
});
