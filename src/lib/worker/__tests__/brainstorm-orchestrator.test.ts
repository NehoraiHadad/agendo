/**
 * Tests for BrainstormOrchestrator — Issues #1, #5, #6
 *
 * #1 — collectSingleTurnResponse handles agent:text-delta (ACP agents)
 * #5 — subscribeToSession is idempotent (no double-subscription on resume)
 * #6 — Delta batching: rapid text-delta events are coalesced into a single brainstorm event
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgendoEvent } from '@/lib/realtime/event-types';

// ---------------------------------------------------------------------------
// Mock: worker-sse
// Capture addSessionEventListener calls so tests can fire events into them.
// ---------------------------------------------------------------------------

/** Registered session event listeners: sessionId → callback[] */
const sessionListeners = new Map<string, Array<(event: AgendoEvent) => void>>();

const mockAddSessionEventListener = vi.fn((sessionId: string, cb: (event: AgendoEvent) => void) => {
  if (!sessionListeners.has(sessionId)) {
    sessionListeners.set(sessionId, []);
  }
  sessionListeners.get(sessionId)!.push(cb);
  return () => {
    const cbs = sessionListeners.get(sessionId);
    if (cbs) {
      const idx = cbs.indexOf(cb);
      if (idx >= 0) cbs.splice(idx, 1);
    }
  };
});

/** Captured brainstorm events emitted via in-memory listeners */
const emittedBrainstormEvents: unknown[] = [];

const mockBrainstormEventListeners = new Map<string, Set<(event: unknown) => void>>();

vi.mock('@/lib/worker/worker-sse', () => ({
  addSessionEventListener: mockAddSessionEventListener,
  brainstormEventListeners: mockBrainstormEventListeners,
  sessionEventListeners: new Map(),
  addBrainstormEventListener: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: worker-client
// ---------------------------------------------------------------------------

vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionControl: vi.fn().mockResolvedValue({ ok: true, dispatched: true }),
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

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
  updateBrainstormStatus: mockUpdateBrainstormStatus,
  updateBrainstormWave: mockUpdateBrainstormWave,
  updateParticipantSession: mockUpdateParticipantSession,
  updateParticipantStatus: mockUpdateParticipantStatus,
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

/** Fire an AgendoEvent to all listeners subscribed to the given sessionId */
function fireSessionEvent(
  sessionId: string,
  payload: Partial<AgendoEvent> & { type: string },
): void {
  const callbacks = sessionListeners.get(sessionId) ?? [];
  const event = { id: 1, sessionId, ts: Date.now(), ...payload } as AgendoEvent;
  for (const cb of callbacks) {
    cb(event);
  }
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  sessionListeners.clear();
  emittedBrainstormEvents.length = 0;
  mockBrainstormEventListeners.clear();
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

    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      collectSingleTurnResponse: (sessionId: string) => Promise<string>;
      unsubscribers: Array<() => void>;
    };

    // Start collecting (subscribes before enqueue would happen)
    const resultPromise = orchestrator.collectSingleTurnResponse(sessionId);

    // Simulate ACP agent streaming text-delta events
    fireSessionEvent(sessionId, { type: 'agent:text-delta', text: 'Hello ' });
    fireSessionEvent(sessionId, { type: 'agent:text-delta', text: 'world' });
    fireSessionEvent(sessionId, { type: 'agent:text-delta', text: '!' });

    // Simulate turn completion
    fireSessionEvent(sessionId, { type: 'session:state', status: 'awaiting_input' });

    const result = await resultPromise;

    expect(result).toBe('Hello world!');
  });

  it('ignores agent:text-delta events with fromDelta=true', async () => {
    const sessionId = 'synth-session-2';

    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      collectSingleTurnResponse: (sessionId: string) => Promise<string>;
    };

    const resultPromise = orchestrator.collectSingleTurnResponse(sessionId);

    // fromDelta=true events should be ignored (they are re-emissions of already-accumulated text)
    fireSessionEvent(sessionId, {
      type: 'agent:text-delta',
      text: 'ignored',
      fromDelta: true,
    } as AgendoEvent & { type: 'agent:text-delta' });
    // Non-fromDelta delta should be accumulated
    fireSessionEvent(sessionId, { type: 'agent:text-delta', text: 'real text' });
    fireSessionEvent(sessionId, { type: 'session:state', status: 'awaiting_input' });

    const result = await resultPromise;
    expect(result).toBe('real text');
  });

  it('handles agent:text replacing accumulated deltas (authoritative complete text)', async () => {
    const sessionId = 'synth-session-3';

    const orchestrator = new BrainstormOrchestrator('room-123', 3, 120) as unknown as {
      collectSingleTurnResponse: (sessionId: string) => Promise<string>;
    };

    const resultPromise = orchestrator.collectSingleTurnResponse(sessionId);

    // Deltas arrive first
    fireSessionEvent(sessionId, { type: 'agent:text-delta', text: 'partial ' });
    fireSessionEvent(sessionId, { type: 'agent:text-delta', text: 'content' });

    // Authoritative complete text replaces the accumulated deltas
    fireSessionEvent(sessionId, { type: 'agent:text', text: 'complete authoritative text' });

    fireSessionEvent(sessionId, { type: 'session:state', status: 'awaiting_input' });

    const result = await resultPromise;
    // Should return the authoritative agent:text, not the deltas
    expect(result).toBe('complete authoritative text');
  });
});

// ---------------------------------------------------------------------------
// #5 — subscribeToSession is idempotent
// ---------------------------------------------------------------------------

describe('subscribeToSession idempotency', () => {
  it('calls addSessionEventListener only once when subscribeToSession is called twice with same sessionId', () => {
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
      }) => void;
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
    orchestrator.subscribeToSession(participant);
    orchestrator.subscribeToSession(participant);

    // addSessionEventListener should have been called exactly once for this sessionId
    const callsForSession = mockAddSessionEventListener.mock.calls.filter(
      (c) => c[0] === 'session-abc',
    );
    expect(callsForSession).toHaveLength(1);
  });

  it('subscribes independently for different sessionIds', () => {
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
      }) => void;
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

    orchestrator.subscribeToSession({ ...base, sessionId: 'session-A' });
    orchestrator.subscribeToSession({ ...base, sessionId: 'session-B' });

    // Both sessionIds should have exactly one subscription
    expect(mockAddSessionEventListener.mock.calls.filter((c) => c[0] === 'session-A')).toHaveLength(
      1,
    );
    expect(mockAddSessionEventListener.mock.calls.filter((c) => c[0] === 'session-B')).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// #6 — Delta batching: rapid deltas are coalesced into a single brainstorm event
// ---------------------------------------------------------------------------

describe('delta batching', () => {
  it('batches multiple rapid text-delta events into a single emitEvent call', async () => {
    vi.useFakeTimers();

    const roomId = 'room-123';
    // Register a listener to capture brainstorm events
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 3, 120) as unknown as {
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

    // Fire 5 rapid text-delta events — should NOT emit message:delta immediately
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'a' });
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'b' });
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'c' });
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'd' });
    orchestrator.handleSessionEvent(participant, { type: 'agent:text-delta', text: 'e' });

    // Before the flush timer fires: no message:delta event yet
    const deltaEventsBefore = capturedEvents.filter(
      (e) => (e as { type?: string }).type === 'message:delta',
    );
    expect(deltaEventsBefore).toHaveLength(0);

    // Advance time past DELTA_FLUSH_INTERVAL_MS (150ms)
    await vi.advanceTimersByTimeAsync(200);

    // Now exactly one message:delta event should have been emitted with concatenated text
    const deltaEventsAfter = capturedEvents.filter(
      (e) => (e as { type?: string }).type === 'message:delta',
    );
    expect(deltaEventsAfter).toHaveLength(1);

    const emittedEvent = deltaEventsAfter[0] as { type: string; text: string; agentId: string };
    expect(emittedEvent.text).toBe('abcde');
    expect(emittedEvent.agentId).toBe('agent-1');

    // responseBuffer should have all the chunks accumulated (for turn-complete)
    expect(participant.responseBuffer).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('resets delta buffer after flush so the next batch starts fresh', async () => {
    vi.useFakeTimers();

    const roomId = 'room-456';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 3, 120) as unknown as {
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

    // There should be exactly two separate message:delta events
    const deltaEvents = capturedEvents.filter(
      (e) => (e as { type?: string }).type === 'message:delta',
    );
    expect(deltaEvents).toHaveLength(2);

    const texts = deltaEvents.map((e) => (e as { text: string }).text);
    expect(texts[0]).toBe('first');
    expect(texts[1]).toBe('second');
  });

  it('does not emit message:delta for fromDelta=true events', async () => {
    vi.useFakeTimers();

    const roomId = 'room-789';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 3, 120) as unknown as {
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

    const deltaEvents = capturedEvents.filter(
      (e) => (e as { type?: string }).type === 'message:delta',
    );
    expect(deltaEvents).toHaveLength(0);
    expect(participant.responseBuffer).toHaveLength(0);
    expect(participant.deltaBuffer).toBe('');
  });
});
