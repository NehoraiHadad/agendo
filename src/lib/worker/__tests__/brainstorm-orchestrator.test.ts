/**
 * Tests for BrainstormOrchestrator — Issues #1, #5, #6
 *
 * #1 — collectSingleTurnResponse handles agent:text-delta (ACP agents)
 * #5 — subscribeToSession is idempotent (no double-subscription on resume)
 * #6 — Delta batching: rapid text-delta events are coalesced into a single PG NOTIFY publish
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: pg-notify
// ---------------------------------------------------------------------------

/** Capture subscribe handlers so tests can fire events into them */
const subscribeHandlers = new Map<string, ((payload: string) => void)[]>();
const mockSubscribe = vi.fn(async (channel: string, handler: (payload: string) => void) => {
  if (!subscribeHandlers.has(channel)) {
    subscribeHandlers.set(channel, []);
  }
  subscribeHandlers.get(channel)!.push(handler);
  return () => {
    const handlers = subscribeHandlers.get(channel);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  };
});

const mockPublish = vi.fn().mockResolvedValue(undefined);
const mockChannelName = vi.fn((prefix: string, id: string) => `${prefix}_${id}`);

vi.mock('@/lib/realtime/pg-notify', () => ({
  subscribe: mockSubscribe,
  publish: mockPublish,
  channelName: mockChannelName,
}));

// ---------------------------------------------------------------------------
// Mock: brainstorm-service
// ---------------------------------------------------------------------------

const mockGetBrainstorm = vi.fn();
const mockUpdateBrainstormStatus = vi.fn().mockResolvedValue(undefined);
const mockUpdateBrainstormWave = vi.fn().mockResolvedValue(undefined);
const mockUpdateParticipantSession = vi.fn().mockResolvedValue(undefined);
const mockUpdateParticipantStatus = vi.fn().mockResolvedValue(undefined);
const mockAddMessage = vi.fn().mockResolvedValue({ id: 'msg-1' });
const mockGetMessages = vi.fn().mockResolvedValue([]);
const mockSetBrainstormSynthesis = vi.fn().mockResolvedValue(undefined);
const mockUpdateParticipantStreamingText = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
  updateBrainstormStatus: mockUpdateBrainstormStatus,
  updateBrainstormWave: mockUpdateBrainstormWave,
  updateParticipantSession: mockUpdateParticipantSession,
  updateParticipantStatus: mockUpdateParticipantStatus,
  updateParticipantStreamingText: mockUpdateParticipantStreamingText,
  addMessage: mockAddMessage,
  getMessages: mockGetMessages,
  setBrainstormSynthesis: mockSetBrainstormSynthesis,
}));

// ---------------------------------------------------------------------------
// Mock: session-service
// ---------------------------------------------------------------------------

const mockCreateSession = vi.fn();
const mockGetSessionStatus = vi.fn();

vi.mock('@/lib/services/session-service', () => ({
  createSession: mockCreateSession,
  getSessionStatus: mockGetSessionStatus,
}));

// ---------------------------------------------------------------------------
// Mock: queue
// ---------------------------------------------------------------------------

const mockEnqueueSession = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/worker/queue', () => ({
  enqueueSession: mockEnqueueSession,
}));

// ---------------------------------------------------------------------------
// Mock: session-runner
// ---------------------------------------------------------------------------

const mockGetSessionProc = vi.fn().mockReturnValue(null);

vi.mock('@/lib/worker/session-runner', () => ({
  getSessionProc: mockGetSessionProc,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { BrainstormOrchestrator } = await import('../brainstorm-orchestrator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fire a raw JSON payload at every handler subscribed to the given channel */
function fireEvent(channel: string, payload: unknown): void {
  const handlers = subscribeHandlers.get(channel) ?? [];
  const raw = JSON.stringify(payload);
  for (const h of handlers) {
    h(raw);
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  subscribeHandlers.clear();
  mockPublish.mockResolvedValue(undefined);
  mockUpdateBrainstormStatus.mockResolvedValue(undefined);
  mockUpdateBrainstormWave.mockResolvedValue(undefined);
  mockUpdateParticipantSession.mockResolvedValue(undefined);
  mockUpdateParticipantStatus.mockResolvedValue(undefined);
  mockAddMessage.mockResolvedValue({ id: 'msg-1' });
  mockGetMessages.mockResolvedValue([]);
  mockSetBrainstormSynthesis.mockResolvedValue(undefined);
  mockEnqueueSession.mockResolvedValue(undefined);
  mockGetSessionProc.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// #1 — collectSingleTurnResponse handles agent:text-delta
// ---------------------------------------------------------------------------

describe('collectSingleTurnResponse', () => {
  it('accumulates agent:text-delta events and resolves on awaiting_input', async () => {
    const sessionId = 'synth-session-1';
    const channel = `agendo_events_${sessionId}`;

    // collectSingleTurnResponse is private — exercise it via runSynthesis by
    // providing a complete room whose wave loop calls runSynthesis.
    // Easier approach: access private method via type casting.
    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      collectSingleTurnResponse: (sessionId: string) => Promise<string>;
      unsubscribers: Array<() => void>;
    };

    // Start collecting (subscribes before enqueue would happen)
    const resultPromise = orchestrator.collectSingleTurnResponse(sessionId);

    // Simulate ACP agent streaming text-delta events
    fireEvent(channel, { type: 'agent:text-delta', text: 'Hello ' });
    fireEvent(channel, { type: 'agent:text-delta', text: 'world' });
    fireEvent(channel, { type: 'agent:text-delta', text: '!' });

    // Simulate turn completion
    fireEvent(channel, { type: 'session:state', status: 'awaiting_input' });

    const result = await resultPromise;

    expect(result).toBe('Hello world!');
  });

  it('ignores agent:text-delta events with fromDelta=true', async () => {
    const sessionId = 'synth-session-2';
    const channel = `agendo_events_${sessionId}`;

    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      collectSingleTurnResponse: (sessionId: string) => Promise<string>;
    };

    const resultPromise = orchestrator.collectSingleTurnResponse(sessionId);

    // fromDelta=true events should be ignored (they are re-emissions of already-accumulated text)
    fireEvent(channel, { type: 'agent:text-delta', text: 'ignored', fromDelta: true });
    // Non-fromDelta delta should be accumulated
    fireEvent(channel, { type: 'agent:text-delta', text: 'real text' });
    fireEvent(channel, { type: 'session:state', status: 'awaiting_input' });

    const result = await resultPromise;
    expect(result).toBe('real text');
  });

  it('handles agent:text replacing accumulated deltas (authoritative complete text)', async () => {
    const sessionId = 'synth-session-3';
    const channel = `agendo_events_${sessionId}`;

    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      collectSingleTurnResponse: (sessionId: string) => Promise<string>;
    };

    const resultPromise = orchestrator.collectSingleTurnResponse(sessionId);

    // Deltas arrive first
    fireEvent(channel, { type: 'agent:text-delta', text: 'partial ' });
    fireEvent(channel, { type: 'agent:text-delta', text: 'content' });

    // Authoritative complete text replaces the accumulated deltas
    fireEvent(channel, { type: 'agent:text', text: 'complete authoritative text' });

    fireEvent(channel, { type: 'session:state', status: 'awaiting_input' });

    const result = await resultPromise;
    // Should return the authoritative agent:text, not the deltas
    expect(result).toBe('complete authoritative text');
  });
});

// ---------------------------------------------------------------------------
// #5 — subscribeToSession is idempotent
// ---------------------------------------------------------------------------

describe('subscribeToSession idempotency', () => {
  it('calls subscribe only once when subscribeToSession is called twice with same sessionId', async () => {
    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      subscribeToSession: (participant: {
        sessionId: string | null;
        agentId: string;
        agentName: string;
        agentSlug: string;
        participantId: string;
        waveStatus: string;
        responseBuffer: string[];
        hasPassed: boolean;
        hasLeft: boolean;
        deltaBuffer: string;
        deltaFlushTimer: ReturnType<typeof setTimeout> | null;
      }) => Promise<void>;
    };

    const participant = {
      sessionId: 'session-abc',
      agentId: 'agent-1',
      agentName: 'Agent1',
      agentSlug: 'agent-slug-1',
      participantId: 'part-1',
      waveStatus: 'pending' as const,
      responseBuffer: [] as string[],
      hasPassed: false,
      hasLeft: false,
      deltaBuffer: '',
      deltaFlushTimer: null,
    };

    // Call twice with the same participant/sessionId
    await orchestrator.subscribeToSession(participant);
    await orchestrator.subscribeToSession(participant);

    // subscribe should have been called exactly once
    const sessionChannel = 'agendo_events_session-abc';
    const channelCalls = mockSubscribe.mock.calls.filter((c) => c[0] === sessionChannel);
    expect(channelCalls).toHaveLength(1);
  });

  it('subscribes independently for different sessionIds', async () => {
    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      subscribeToSession: (participant: {
        sessionId: string | null;
        agentId: string;
        agentName: string;
        agentSlug: string;
        participantId: string;
        waveStatus: string;
        responseBuffer: string[];
        hasPassed: boolean;
        hasLeft: boolean;
        deltaBuffer: string;
        deltaFlushTimer: ReturnType<typeof setTimeout> | null;
      }) => Promise<void>;
    };

    const base = {
      agentId: 'agent-1',
      agentName: 'Agent1',
      agentSlug: 'agent-slug-1',
      participantId: 'part-1',
      waveStatus: 'pending' as const,
      responseBuffer: [] as string[],
      hasPassed: false,
      hasLeft: false,
      deltaBuffer: '',
      deltaFlushTimer: null,
    };

    await orchestrator.subscribeToSession({ ...base, sessionId: 'session-A' });
    await orchestrator.subscribeToSession({ ...base, sessionId: 'session-B' });

    // Both channels should have exactly one subscription
    expect(mockSubscribe.mock.calls.filter((c) => c[0] === 'agendo_events_session-A')).toHaveLength(
      1,
    );
    expect(mockSubscribe.mock.calls.filter((c) => c[0] === 'agendo_events_session-B')).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// #6 — Delta batching: rapid deltas are coalesced
// ---------------------------------------------------------------------------

describe('delta batching', () => {
  it('batches multiple rapid text-delta events into a single emitEvent call', async () => {
    vi.useFakeTimers();

    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      handleSessionEvent: (
        participant: {
          sessionId: string | null;
          agentId: string;
          agentName: string;
          agentSlug: string;
          participantId: string;
          waveStatus: string;
          responseBuffer: string[];
          hasPassed: boolean;
          hasLeft: boolean;
          deltaBuffer: string;
          deltaFlushTimer: ReturnType<typeof setTimeout> | null;
          model?: string;
        },
        event: unknown,
      ) => void;
    };

    const participant = {
      sessionId: 'session-xyz',
      agentId: 'agent-1',
      agentName: 'Agent1',
      agentSlug: 'agent-slug-1',
      participantId: 'part-1',
      waveStatus: 'thinking' as const,
      responseBuffer: [] as string[],
      hasPassed: false,
      hasLeft: false,
      deltaBuffer: '',
      deltaFlushTimer: null as ReturnType<typeof setTimeout> | null,
    };

    // Fire 5 rapid text-delta events — should NOT publish immediately
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'a' });
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'b' });
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'c' });
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'd' });
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'e' });

    // Before the flush timer fires: no publish should have happened yet for message:delta
    const deltaPublishsBefore = mockPublish.mock.calls.filter((c) => {
      const payload = c[1] as { type?: string };
      return typeof payload === 'object' && payload?.type === 'message:delta';
    });
    expect(deltaPublishsBefore).toHaveLength(0);

    // Advance time past DELTA_FLUSH_INTERVAL_MS (150ms)
    await vi.advanceTimersByTimeAsync(200);

    // Now exactly one publish for message:delta should have fired with concatenated text
    const deltaPublishsAfter = mockPublish.mock.calls.filter((c) => {
      const payload = c[1] as { type?: string; text?: string };
      return typeof payload === 'object' && payload?.type === 'message:delta';
    });
    expect(deltaPublishsAfter).toHaveLength(1);

    const publishedPayload = deltaPublishsAfter[0][1] as {
      type: string;
      text: string;
      agentId: string;
    };
    expect(publishedPayload.text).toBe('abcde');
    expect(publishedPayload.agentId).toBe('agent-1');

    // responseBuffer should have all the chunks accumulated (for turn-complete)
    expect(participant.responseBuffer).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('resets delta buffer after flush so the next batch starts fresh', async () => {
    vi.useFakeTimers();

    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      handleSessionEvent: (
        participant: {
          sessionId: string | null;
          agentId: string;
          agentName: string;
          agentSlug: string;
          participantId: string;
          waveStatus: string;
          responseBuffer: string[];
          hasPassed: boolean;
          hasLeft: boolean;
          deltaBuffer: string;
          deltaFlushTimer: ReturnType<typeof setTimeout> | null;
          model?: string;
        },
        event: unknown,
      ) => void;
    };

    const participant = {
      sessionId: 'session-xyz',
      agentId: 'agent-2',
      agentName: 'Agent2',
      agentSlug: 'agent-slug-2',
      participantId: 'part-2',
      waveStatus: 'thinking' as const,
      responseBuffer: [] as string[],
      hasPassed: false,
      hasLeft: false,
      deltaBuffer: '',
      deltaFlushTimer: null as ReturnType<typeof setTimeout> | null,
    };

    // First batch
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'first' });
    await vi.advanceTimersByTimeAsync(200);

    // Second batch (after first flush)
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'second' });
    await vi.advanceTimersByTimeAsync(200);

    // There should be exactly two separate message:delta publishes
    const deltaPublishes = mockPublish.mock.calls.filter((c) => {
      const payload = c[1] as { type?: string };
      return typeof payload === 'object' && payload?.type === 'message:delta';
    });
    expect(deltaPublishes).toHaveLength(2);

    const texts = deltaPublishes.map((c) => (c[1] as { text: string }).text);
    expect(texts[0]).toBe('first');
    expect(texts[1]).toBe('second');
  });

  it('does not emit message:delta for fromDelta=true events', async () => {
    vi.useFakeTimers();

    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      handleSessionEvent: (
        participant: {
          sessionId: string | null;
          agentId: string;
          agentName: string;
          agentSlug: string;
          participantId: string;
          waveStatus: string;
          responseBuffer: string[];
          hasPassed: boolean;
          hasLeft: boolean;
          deltaBuffer: string;
          deltaFlushTimer: ReturnType<typeof setTimeout> | null;
          model?: string;
        },
        event: unknown,
      ) => void;
    };

    const participant = {
      sessionId: 'session-xyz',
      agentId: 'agent-3',
      agentName: 'Agent3',
      agentSlug: 'agent-slug-3',
      participantId: 'part-3',
      waveStatus: 'thinking' as const,
      responseBuffer: [] as string[],
      hasPassed: false,
      hasLeft: false,
      deltaBuffer: '',
      deltaFlushTimer: null as ReturnType<typeof setTimeout> | null,
    };

    // fromDelta=true events should be completely ignored
    orchestrator.handleSessionEvent(participant, {
      type: 'agent:text-delta',
      text: 'should be ignored',
      fromDelta: true,
    });
    await vi.advanceTimersByTimeAsync(200);

    const deltaPublishes = mockPublish.mock.calls.filter((c) => {
      const payload = c[1] as { type?: string };
      return typeof payload === 'object' && payload?.type === 'message:delta';
    });
    expect(deltaPublishes).toHaveLength(0);
    expect(participant.responseBuffer).toHaveLength(0);
    expect(participant.deltaBuffer).toBe('');
  });
});
