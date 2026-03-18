/**
 * Tests for brainstorm-history.ts
 *
 * Covers:
 * - getBrainstormHistoryFromSessions() returns events when live procs available
 * - getBrainstormHistoryFromSessions() falls back gracefully when no live procs
 * - Messages are ordered correctly by wave (turn index)
 * - Works with mixed adapters (some with history, some without)
 * - buildTranscriptFromSessions() builds correct transcript for synthesis
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: session-runner (getSessionProc)
// ---------------------------------------------------------------------------

const { mockGetSessionProc } = vi.hoisted(() => ({
  mockGetSessionProc: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@/lib/worker/session-runner', () => ({
  getSessionProc: mockGetSessionProc,
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  getBrainstormHistoryFromSessions,
  buildTranscriptFromSessions,
} from '../brainstorm-history';
import type { BrainstormWithDetails } from '@/lib/services/brainstorm-service';
import type { AgendoEventPayload } from '@/lib/realtime/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal BrainstormWithDetails for testing */
function makeRoom(
  participants: Array<{
    agentId: string;
    agentName: string;
    sessionId?: string | null;
  }>,
): BrainstormWithDetails {
  return {
    id: 'room-1',
    roomId: 'room-1',
    status: 'ended',
    topic: 'What is the best architecture?',
    title: 'Architecture Discussion',
    maxWaves: 5,
    currentWave: 2,
    synthesis: null,
    logFilePath: null,
    projectId: 'proj-1',
    taskId: null,
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    participants: participants.map((p) => ({
      id: `participant-${p.agentId}`,
      roomId: 'room-1',
      agentId: p.agentId,
      agentName: p.agentName,
      agentSlug: p.agentName.toLowerCase().replace(/\s+/g, '-'),
      sessionId: p.sessionId ?? null,
      model: null,
      status: 'done' as const,
      joinedAt: new Date(),
    })),
    project: { id: 'proj-1', name: 'Test Project' },
    task: null,
  } as unknown as BrainstormWithDetails;
}

/** Build a mock SessionProcess with getHistory returning given payloads */
function makeProc(history: AgendoEventPayload[] | null) {
  return {
    getHistory: vi.fn().mockResolvedValue(history),
  };
}

/** Build a sequence of agent:text + user:message payloads simulating N turns */
function makeTurnHistory(agentResponses: string[]): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];
  for (let i = 0; i < agentResponses.length; i++) {
    // Each turn: user asks, agent responds
    events.push({
      type: 'user:message',
      text: i === 0 ? 'Initial topic' : 'Next wave prompt',
    } as AgendoEventPayload);
    events.push({
      type: 'agent:text',
      text: agentResponses[i],
    } as AgendoEventPayload);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSessionProc.mockReturnValue(undefined);
});

describe('getBrainstormHistoryFromSessions', () => {
  it('returns empty array when no participants have sessionIds', async () => {
    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice' }]);
    const events = await getBrainstormHistoryFromSessions(room);
    expect(events).toHaveLength(0);
  });

  it('returns empty array when no live procs found', async () => {
    mockGetSessionProc.mockReturnValue(undefined);
    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const events = await getBrainstormHistoryFromSessions(room);
    expect(events).toHaveLength(0);
  });

  it('returns empty array when getHistory returns null', async () => {
    mockGetSessionProc.mockReturnValue(makeProc(null));
    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const events = await getBrainstormHistoryFromSessions(room);
    expect(events).toHaveLength(0);
  });

  it('returns empty array when getHistory returns empty array', async () => {
    mockGetSessionProc.mockReturnValue(makeProc([]));
    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const events = await getBrainstormHistoryFromSessions(room);
    expect(events).toHaveLength(0);
  });

  it('maps agent:text events to BrainstormEvent message events', async () => {
    const history = makeTurnHistory(['Response to wave 0', 'Response to wave 1']);
    mockGetSessionProc.mockReturnValue(makeProc(history));

    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const events = await getBrainstormHistoryFromSessions(room);

    expect(events.length).toBeGreaterThan(0);

    const messageEvents = events.filter((e) => e.type === 'message');
    expect(messageEvents).toHaveLength(2);

    // Wave 0 message
    const wave0 = messageEvents[0];
    expect(wave0.type).toBe('message');
    if (wave0.type === 'message') {
      expect(wave0.wave).toBe(0);
      expect(wave0.senderType).toBe('agent');
      expect(wave0.agentId).toBe('agent-1');
      expect(wave0.agentName).toBe('Alice');
      expect(wave0.content).toBe('Response to wave 0');
      expect(wave0.isPass).toBe(false);
    }

    // Wave 1 message
    const wave1 = messageEvents[1];
    expect(wave1.type).toBe('message');
    if (wave1.type === 'message') {
      expect(wave1.wave).toBe(1);
      expect(wave1.content).toBe('Response to wave 1');
    }
  });

  it('merges messages from multiple participants ordered by wave', async () => {
    const historyAlice = makeTurnHistory(['Alice wave 0', 'Alice wave 1']);
    const historyBob = makeTurnHistory(['Bob wave 0', 'Bob wave 1']);

    mockGetSessionProc
      .mockReturnValueOnce(makeProc(historyAlice))
      .mockReturnValueOnce(makeProc(historyBob));

    const room = makeRoom([
      { agentId: 'agent-alice', agentName: 'Alice', sessionId: 'sess-alice' },
      { agentId: 'agent-bob', agentName: 'Bob', sessionId: 'sess-bob' },
    ]);
    const events = await getBrainstormHistoryFromSessions(room);

    const messageEvents = events.filter((e) => e.type === 'message');
    expect(messageEvents).toHaveLength(4);

    // Wave 0 messages come before wave 1 messages
    const wave0Messages = messageEvents.filter((e) => e.type === 'message' && e.wave === 0);
    const wave1Messages = messageEvents.filter((e) => e.type === 'message' && e.wave === 1);

    expect(wave0Messages).toHaveLength(2);
    expect(wave1Messages).toHaveLength(2);

    // All wave 0 messages appear before any wave 1 messages
    const lastWave0Pos = events.lastIndexOf(wave0Messages[wave0Messages.length - 1]);
    const firstWave1Pos = events.indexOf(wave1Messages[0]);
    expect(lastWave0Pos).toBeLessThan(firstWave1Pos);
  });

  it('handles mixed adapters: some with history, some without', async () => {
    const historyAlice = makeTurnHistory(['Alice wave 0']);
    // Bob has no live proc
    mockGetSessionProc.mockReturnValueOnce(makeProc(historyAlice)).mockReturnValueOnce(undefined);

    const room = makeRoom([
      { agentId: 'agent-alice', agentName: 'Alice', sessionId: 'sess-alice' },
      { agentId: 'agent-bob', agentName: 'Bob', sessionId: 'sess-bob' },
    ]);
    const events = await getBrainstormHistoryFromSessions(room);

    const messageEvents = events.filter((e) => e.type === 'message');
    // Only Alice's messages — Bob had no proc
    expect(messageEvents).toHaveLength(1);
    if (messageEvents[0].type === 'message') {
      expect(messageEvents[0].agentId).toBe('agent-alice');
    }
  });

  it('returns empty array when at least one participant has history but all have no sessionId', async () => {
    // No sessionIds at all
    const room = makeRoom([
      { agentId: 'agent-1', agentName: 'Alice' }, // no sessionId
      { agentId: 'agent-2', agentName: 'Bob' }, // no sessionId
    ]);
    const events = await getBrainstormHistoryFromSessions(room);
    expect(events).toHaveLength(0);
    expect(mockGetSessionProc).not.toHaveBeenCalled();
  });

  it('assigns sequential ids starting from 1', async () => {
    const history = makeTurnHistory(['Wave 0 response']);
    mockGetSessionProc.mockReturnValue(makeProc(history));

    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const events = await getBrainstormHistoryFromSessions(room);

    expect(events.length).toBeGreaterThan(0);
    // IDs should be sequential positive integers
    for (let i = 0; i < events.length; i++) {
      expect(events[i].id).toBe(i + 1);
    }
  });

  it('sets roomId on all returned events', async () => {
    const history = makeTurnHistory(['Response']);
    mockGetSessionProc.mockReturnValue(makeProc(history));

    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const events = await getBrainstormHistoryFromSessions(room);

    for (const event of events) {
      expect(event.roomId).toBe('room-1');
    }
  });
});

describe('buildTranscriptFromSessions', () => {
  it('returns null when no participants have live procs', async () => {
    mockGetSessionProc.mockReturnValue(undefined);
    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const result = await buildTranscriptFromSessions(room);
    expect(result).toBeNull();
  });

  it('returns null when all getHistory() calls return null', async () => {
    mockGetSessionProc.mockReturnValue(makeProc(null));
    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const result = await buildTranscriptFromSessions(room);
    expect(result).toBeNull();
  });

  it('builds a transcript string from session histories', async () => {
    const history = makeTurnHistory(['I think microservices is the answer.', 'PASS']);
    mockGetSessionProc.mockReturnValue(makeProc(history));

    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice', sessionId: 'sess-1' }]);
    const result = await buildTranscriptFromSessions(room);

    expect(result).not.toBeNull();
    expect(result).toContain('Wave 0');
    expect(result).toContain('[Alice]');
    expect(result).toContain('I think microservices is the answer.');
  });

  it('builds multi-participant transcript ordered by wave', async () => {
    const historyAlice = makeTurnHistory(['Alice: Use microservices']);
    const historyBob = makeTurnHistory(['Bob: Use monolith']);

    mockGetSessionProc
      .mockReturnValueOnce(makeProc(historyAlice))
      .mockReturnValueOnce(makeProc(historyBob));

    const room = makeRoom([
      { agentId: 'agent-alice', agentName: 'Alice', sessionId: 'sess-alice' },
      { agentId: 'agent-bob', agentName: 'Bob', sessionId: 'sess-bob' },
    ]);
    const result = await buildTranscriptFromSessions(room);

    expect(result).not.toBeNull();
    expect(result).toContain('Alice');
    expect(result).toContain('Bob');
    expect(result).toContain('microservices');
    expect(result).toContain('monolith');
  });

  it('returns null when no participants have sessionIds', async () => {
    const room = makeRoom([{ agentId: 'agent-1', agentName: 'Alice' }]);
    const result = await buildTranscriptFromSessions(room);
    expect(result).toBeNull();
  });
});
