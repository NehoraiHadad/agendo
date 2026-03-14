import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks — must be declared before any imports that reference the mocked modules
// ============================================================================

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: vi.fn(),
  getMessages: vi.fn(),
}));

vi.mock('@/lib/realtime/pg-notify', () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  channelName: vi.fn((prefix: string, id: string) => `${prefix}_${id.replace(/-/g, '')}`),
}));

vi.mock('@/lib/api-handler', () => ({
  assertUUID: vi.fn(),
}));

import { GET } from '../[id]/events/route';
import { getBrainstorm, getMessages } from '@/lib/services/brainstorm-service';

// ============================================================================
// Helpers
// ============================================================================

const ROOM_ID = '00000000-0000-0000-0000-000000000001';

/** Read all SSE frames from a Response stream and return them parsed. */
async function readSseFrames(
  response: Response,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  // Read until the controller is closed or we've collected enough frames.
  // Use a timeout-based approach: after receiving at least one frame, try
  // to read more for a short window then bail out.
  const timeout = 200; // ms
  const deadline = Date.now() + timeout;

  outer: while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), timeout),
      ),
    ]);
    if (done || value === undefined) break outer;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  reader.cancel().catch(() => {});

  const raw = chunks.join('');
  const frames: Array<{ id: string; data: Record<string, unknown> }> = [];

  // Parse SSE format: id: …\ndata: …\n\n
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const idMatch = trimmed.match(/^id:\s*(.+)$/m);
    const dataMatch = trimmed.match(/^data:\s*(.+)$/m);

    if (idMatch && dataMatch) {
      frames.push({
        id: idMatch[1].trim(),
        data: JSON.parse(dataMatch[1].trim()) as Record<string, unknown>,
      });
    }
  }

  return frames;
}

/** Build a minimal BrainstormWithDetails mock */
function makeRoom(
  participants: Array<{
    id: string;
    agentId: string;
    agentName: string;
    agentSlug: string;
    status: string;
    sessionId?: string | null;
    model?: string | null;
    roomId?: string;
    joinedAt?: Date;
  }>,
) {
  return {
    id: ROOM_ID,
    status: 'active',
    title: 'Test Room',
    topic: 'Testing',
    maxWaves: 5,
    currentWave: 1,
    projectId: null,
    taskId: null,
    config: {},
    synthesis: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    participants: participants.map((p) => ({
      id: p.id,
      roomId: p.roomId ?? ROOM_ID,
      agentId: p.agentId,
      agentName: p.agentName,
      agentSlug: p.agentSlug,
      status: p.status,
      sessionId: p.sessionId ?? null,
      model: p.model ?? null,
      joinedAt: p.joinedAt ?? new Date(),
    })),
    messages: [],
    project: null,
    task: null,
  };
}

/** Build a minimal message row. */
function makeMessage(i: number, agentId: string, content = `Message ${i}`) {
  return {
    id: `msg-${i}`,
    roomId: ROOM_ID,
    wave: 1,
    senderType: 'agent',
    senderAgentId: agentId,
    isPass: false,
    content,
    createdAt: new Date(Date.now() + i * 1000),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/brainstorms/[id]/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('lastEventId — skipping already-seen messages', () => {
    it('sends all messages when lastEventId is absent (fresh connect)', async () => {
      const agentId = 'agent-aaa';
      const messages = [1, 2, 3, 4, 5].map((i) => makeMessage(i, agentId));

      vi.mocked(getBrainstorm).mockResolvedValue(makeRoom([]) as never);
      vi.mocked(getMessages).mockResolvedValue(messages as never);

      const req = new NextRequest(`http://localhost/api/brainstorms/${ROOM_ID}/events`);
      const response = await GET(req, { params: Promise.resolve({ id: ROOM_ID }) });

      const frames = await readSseFrames(response);
      const messageFrames = frames.filter((f) => f.data.type === 'message');

      expect(messageFrames).toHaveLength(5);
      // Event ids should be 1-5
      const ids = messageFrames.map((f) => Number(f.id));
      expect(ids).toEqual([1, 2, 3, 4, 5]);
    });

    it('skips messages with eventId <= lastEventId on reconnect', async () => {
      const agentId = 'agent-aaa';
      const messages = [1, 2, 3, 4, 5].map((i) => makeMessage(i, agentId));

      vi.mocked(getBrainstorm).mockResolvedValue(makeRoom([]) as never);
      vi.mocked(getMessages).mockResolvedValue(messages as never);

      const req = new NextRequest(
        `http://localhost/api/brainstorms/${ROOM_ID}/events?lastEventId=3`,
      );
      const response = await GET(req, { params: Promise.resolve({ id: ROOM_ID }) });

      const frames = await readSseFrames(response);
      const messageFrames = frames.filter((f) => f.data.type === 'message');

      // Only messages 4 and 5 (eventId 4 and 5) should be replayed
      expect(messageFrames).toHaveLength(2);
      const ids = messageFrames.map((f) => Number(f.id));
      expect(ids).toEqual([4, 5]);
    });

    it('sends no historical messages when lastEventId equals total message count', async () => {
      const agentId = 'agent-aaa';
      const messages = [1, 2, 3].map((i) => makeMessage(i, agentId));

      vi.mocked(getBrainstorm).mockResolvedValue(makeRoom([]) as never);
      vi.mocked(getMessages).mockResolvedValue(messages as never);

      const req = new NextRequest(
        `http://localhost/api/brainstorms/${ROOM_ID}/events?lastEventId=3`,
      );
      const response = await GET(req, { params: Promise.resolve({ id: ROOM_ID }) });

      const frames = await readSseFrames(response);
      const messageFrames = frames.filter((f) => f.data.type === 'message');

      expect(messageFrames).toHaveLength(0);
    });
  });
});
