import { NextRequest, NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';
import { getParticipantBySessionId, getBrainstorm } from '@/lib/services/brainstorm-service';

/**
 * GET /api/brainstorms/state?sessionId=...
 *
 * Called by the MCP server's brainstorm_get_state tool. Returns the current
 * brainstorm room state from the perspective of the calling session's participant.
 */
export const GET = withErrorBoundary(async (req: NextRequest) => {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json(
      { error: { message: 'sessionId query parameter is required' } },
      { status: 400 },
    );
  }

  // Find the brainstorm participant linked to this session
  const participant = await getParticipantBySessionId(sessionId);
  if (!participant) {
    return NextResponse.json(
      { error: { message: 'No brainstorm participant found for this session' } },
      { status: 404 },
    );
  }

  // Get the full room details
  const room = await getBrainstorm(participant.roomId);

  const participants = room.participants.map((p) => ({
    name: p.agentName,
    role: p.role ?? null,
    status: p.status,
    isLeader: room.leaderParticipantId === p.id,
  }));

  return NextResponse.json({
    data: {
      roomId: room.id,
      currentWave: room.currentWave + 1,
      maxWaves: room.maxWaves,
      status: room.status,
      participants,
      myRole: participant.role,
      isLeader: room.leaderParticipantId === participant.id,
    },
  });
});
