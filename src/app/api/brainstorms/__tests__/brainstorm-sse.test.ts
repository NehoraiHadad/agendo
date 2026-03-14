import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ============================================================================
// Mocks — must be declared before any imports that reference the mocked modules
// ============================================================================

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: vi.fn(),
}));

vi.mock('@/lib/realtime/pg-notify', () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  channelName: vi.fn((prefix: string, id: string) => `${prefix}_${id.replace(/-/g, '')}`),
}));

vi.mock('@/lib/api-handler', () => ({
  assertUUID: vi.fn(),
}));

// Mock fs so we control log file reads without touching the real filesystem
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('@/lib/realtime/event-utils', () => ({
  readBrainstormEventsFromLog: vi.fn(),
}));

import { GET } from '../[id]/events/route';
import { getBrainstorm } from '@/lib/services/brainstorm-service';
import { existsSync, readFileSync } from 'node:fs';
import { readBrainstormEventsFromLog } from '@/lib/realtime/event-utils';

// ============================================================================
// Helpers
// ============================================================================

const ROOM_ID = '00000000-0000-0000-0000-000000000001';
const LOG_PATH = '/tmp/test-brainstorm.log';

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
  logFilePath?: string,
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
    logFilePath: logFilePath ?? null,
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
    project: null,
    task: null,
  };
}

/** Build a minimal BrainstormEvent for use in log replay tests. */
function makeMessageEvent(
  i: number,
  agentId: string,
  content = `Message ${i}`,
): Record<string, unknown> {
  return {
    id: i,
    roomId: ROOM_ID,
    ts: Date.now() + i * 1000,
    type: 'message',
    wave: 1,
    senderType: 'agent',
    agentId,
    content,
    isPass: false,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('GET /api/brainstorms/[id]/events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('log file replay — lastEventId filtering', () => {
    it('sends all events when lastEventId is absent (fresh connect)', async () => {
      const agentId = 'agent-aaa';
      const events = [1, 2, 3, 4, 5].map((i) => makeMessageEvent(i, agentId));

      vi.mocked(getBrainstorm).mockResolvedValue(makeRoom([], LOG_PATH) as never);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('dummy-log-content' as never);
      vi.mocked(readBrainstormEventsFromLog).mockReturnValue(events as never);

      const req = new NextRequest(`http://localhost/api/brainstorms/${ROOM_ID}/events`);
      const response = await GET(req, { params: Promise.resolve({ id: ROOM_ID }) });

      const frames = await readSseFrames(response);
      const messageFrames = frames.filter((f) => f.data.type === 'message');

      expect(messageFrames).toHaveLength(5);
      expect(readBrainstormEventsFromLog).toHaveBeenCalledWith('dummy-log-content', 0);
    });

    it('calls readBrainstormEventsFromLog with lastEventId on reconnect', async () => {
      const agentId = 'agent-aaa';
      // Simulate the log reader returning only events after id=3
      const events = [4, 5].map((i) => makeMessageEvent(i, agentId));

      vi.mocked(getBrainstorm).mockResolvedValue(makeRoom([], LOG_PATH) as never);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('dummy-log-content' as never);
      vi.mocked(readBrainstormEventsFromLog).mockReturnValue(events as never);

      const req = new NextRequest(
        `http://localhost/api/brainstorms/${ROOM_ID}/events?lastEventId=3`,
      );
      const response = await GET(req, { params: Promise.resolve({ id: ROOM_ID }) });

      const frames = await readSseFrames(response);
      const messageFrames = frames.filter((f) => f.data.type === 'message');

      expect(messageFrames).toHaveLength(2);
      expect(readBrainstormEventsFromLog).toHaveBeenCalledWith('dummy-log-content', 3);
    });

    it('skips log replay when room has no logFilePath', async () => {
      vi.mocked(getBrainstorm).mockResolvedValue(makeRoom([]) as never); // no logFilePath
      vi.mocked(existsSync).mockReturnValue(false);

      const req = new NextRequest(`http://localhost/api/brainstorms/${ROOM_ID}/events`);
      const response = await GET(req, { params: Promise.resolve({ id: ROOM_ID }) });

      await readSseFrames(response);

      expect(readBrainstormEventsFromLog).not.toHaveBeenCalled();
    });

    it('skips log replay when log file does not exist', async () => {
      vi.mocked(getBrainstorm).mockResolvedValue(makeRoom([], LOG_PATH) as never);
      vi.mocked(existsSync).mockReturnValue(false); // file missing

      const req = new NextRequest(`http://localhost/api/brainstorms/${ROOM_ID}/events`);
      const response = await GET(req, { params: Promise.resolve({ id: ROOM_ID }) });

      await readSseFrames(response);

      expect(readBrainstormEventsFromLog).not.toHaveBeenCalled();
    });

    it('sends no historical events when log returns empty array', async () => {
      vi.mocked(getBrainstorm).mockResolvedValue(makeRoom([], LOG_PATH) as never);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('dummy-log-content' as never);
      vi.mocked(readBrainstormEventsFromLog).mockReturnValue([]);

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
