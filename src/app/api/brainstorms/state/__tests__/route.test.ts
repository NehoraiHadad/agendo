import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockGetParticipantBySessionId, mockGetBrainstorm } = vi.hoisted(() => ({
  mockGetParticipantBySessionId: vi.fn(),
  mockGetBrainstorm: vi.fn(),
}));

vi.mock('@/lib/services/brainstorm-service', () => ({
  getParticipantBySessionId: mockGetParticipantBySessionId,
  getBrainstorm: mockGetBrainstorm,
}));

import { GET } from '../../state/route';

describe('GET /api/brainstorms/state', () => {
  const PARTICIPANT = {
    id: 'part-1',
    roomId: 'room-1',
    agentId: 'agent-1',
    role: 'critic',
    agentName: 'Claude',
    agentSlug: 'claude-code-1',
  };

  const makeRoom = (currentWave: number, maxWaves = 3) => ({
    id: 'room-1',
    currentWave,
    maxWaves,
    status: 'active',
    leaderParticipantId: 'part-1',
    participants: [
      {
        id: 'part-1',
        agentName: 'Claude',
        role: 'critic',
        status: 'active',
      },
      {
        id: 'part-2',
        agentName: 'Gemini',
        role: 'optimist',
        status: 'active',
      },
    ],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetParticipantBySessionId.mockResolvedValue(PARTICIPANT);
  });

  it('returns currentWave as 1-indexed (DB wave 0 → response wave 1)', async () => {
    mockGetBrainstorm.mockResolvedValue(makeRoom(0));

    const req = new NextRequest('http://localhost/api/brainstorms/state?sessionId=sess-1');
    const res = await GET(req, {} as never);
    const body = await res.json();

    expect(body.data.currentWave).toBe(1);
  });

  it('returns currentWave as 1-indexed (DB wave 2 → response wave 3)', async () => {
    mockGetBrainstorm.mockResolvedValue(makeRoom(2, 5));

    const req = new NextRequest('http://localhost/api/brainstorms/state?sessionId=sess-1');
    const res = await GET(req, {} as never);
    const body = await res.json();

    expect(body.data.currentWave).toBe(3);
    expect(body.data.maxWaves).toBe(5);
  });

  it('returns 400 when sessionId is missing', async () => {
    const req = new NextRequest('http://localhost/api/brainstorms/state');
    const res = await GET(req, {} as never);
    expect(res.status).toBe(400);
  });

  it('returns 404 when no participant found for session', async () => {
    mockGetParticipantBySessionId.mockResolvedValue(null);

    const req = new NextRequest('http://localhost/api/brainstorms/state?sessionId=unknown');
    const res = await GET(req, {} as never);
    expect(res.status).toBe(404);
  });

  it('returns participant role and leader status', async () => {
    mockGetBrainstorm.mockResolvedValue(makeRoom(1));

    const req = new NextRequest('http://localhost/api/brainstorms/state?sessionId=sess-1');
    const res = await GET(req, {} as never);
    const body = await res.json();

    expect(body.data.myRole).toBe('critic');
    expect(body.data.isLeader).toBe(true);
    expect(body.data.participants).toHaveLength(2);
  });
});
