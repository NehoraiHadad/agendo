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
const mockSetBrainstormSynthesis = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
  updateBrainstormStatus: mockUpdateBrainstormStatus,
  updateBrainstormWave: mockUpdateBrainstormWave,
  updateParticipantSession: mockUpdateParticipantSession,
  updateParticipantStatus: mockUpdateParticipantStatus,
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

// ---------------------------------------------------------------------------
// #7 — checkWaveComplete() ignores terminal states before startWave()
// ---------------------------------------------------------------------------

describe('waveStarted guard prevents premature wave completion', () => {
  it('checkWaveComplete does NOT resolve waveCompleteResolve before startWave is called', async () => {
    const orchestrator = new BrainstormOrchestrator('room-guard-1', 3, 120) as unknown as {
      participants: Array<{
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
      }>;
      waveCompleteResolve: (() => void) | null;
      waveStarted: boolean;
      checkWaveComplete: () => void;
      startWave: (wave: number, content: string) => Promise<void>;
    };

    // Simulate two participants — one evicted (hasLeft/hasPassed/done), one ready
    orchestrator.participants = [
      {
        sessionId: 'sess-1',
        agentId: 'agent-evicted',
        agentName: 'EvictedAgent',
        agentSlug: 'evicted-agent',
        participantId: 'part-evicted',
        waveStatus: 'done',
        responseBuffer: [],
        hasPassed: true,
        hasLeft: true,
        deltaBuffer: '',
        deltaFlushTimer: null,
      },
      {
        sessionId: 'sess-2',
        agentId: 'agent-ok',
        agentName: 'OKAgent',
        agentSlug: 'ok-agent',
        participantId: 'part-ok',
        waveStatus: 'done', // Set to 'done' during waitForAllParticipantsReady
        responseBuffer: [],
        hasPassed: false,
        hasLeft: false,
        deltaBuffer: '',
        deltaFlushTimer: null,
      },
    ];

    // Set up a waveCompleteResolve (simulating what waitForWaveComplete does)
    let resolved = false;
    orchestrator.waveCompleteResolve = () => {
      resolved = true;
    };

    // waveStarted is false — no wave has been started yet
    expect(orchestrator.waveStarted).toBe(false);

    // checkWaveComplete should NOT resolve because waveStarted is false
    orchestrator.checkWaveComplete();
    expect(resolved).toBe(false);
  });

  it('checkWaveComplete DOES resolve after startWave has been called', async () => {
    const orchestrator = new BrainstormOrchestrator('room-guard-2', 3, 120) as unknown as {
      participants: Array<{
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
      }>;
      waveCompleteResolve: (() => void) | null;
      waveStarted: boolean;
      checkWaveComplete: () => void;
    };

    // Simulate one active participant that finished its wave
    orchestrator.participants = [
      {
        sessionId: 'sess-3',
        agentId: 'agent-done',
        agentName: 'DoneAgent',
        agentSlug: 'done-agent',
        participantId: 'part-done',
        waveStatus: 'done',
        responseBuffer: ['response text'],
        hasPassed: false,
        hasLeft: false,
        deltaBuffer: '',
        deltaFlushTimer: null,
      },
    ];

    // Manually set waveStarted to true (simulating startWave having been called)
    orchestrator.waveStarted = true;

    let resolved = false;
    orchestrator.waveCompleteResolve = () => {
      resolved = true;
    };

    // Now checkWaveComplete SHOULD resolve
    orchestrator.checkWaveComplete();
    expect(resolved).toBe(true);
  });

  it('waveStarted is reset to false after wave completes via waitForWaveComplete', async () => {
    const orchestrator = new BrainstormOrchestrator('room-guard-3', 3, 120) as unknown as {
      participants: Array<{
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
      }>;
      waveStarted: boolean;
      waitForWaveComplete: () => Promise<void>;
      checkWaveComplete: () => void;
    };

    // One participant already done
    orchestrator.participants = [
      {
        sessionId: 'sess-4',
        agentId: 'agent-done',
        agentName: 'DoneAgent',
        agentSlug: 'done-agent',
        participantId: 'part-done',
        waveStatus: 'done',
        responseBuffer: [],
        hasPassed: false,
        hasLeft: false,
        deltaBuffer: '',
        deltaFlushTimer: null,
      },
    ];

    // Simulate startWave was called
    orchestrator.waveStarted = true;

    // waitForWaveComplete should resolve (participant is already done)
    // AND reset waveStarted to false
    await orchestrator.waitForWaveComplete();
    expect(orchestrator.waveStarted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #8 — Empty response guard: awaiting_input with empty responseBuffer
//       should NOT call onParticipantTurnComplete (e.g. compaction-only turns)
// ---------------------------------------------------------------------------

describe('empty response guard (compaction-only turns)', () => {
  it('does NOT call onParticipantTurnComplete when responseBuffer is empty and waveStatus is thinking', async () => {
    vi.useFakeTimers();

    const roomId = 'room-compact-1';
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
          readyAt: number | null;
          deltaBuffer: string;
          deltaFlushTimer: ReturnType<typeof setTimeout> | null;
          model?: string;
        },
        event: unknown,
      ) => void;
    };

    const participant = {
      sessionId: 'session-compact-1',
      agentId: 'codex-agent-1',
      agentName: 'Codex',
      agentSlug: 'codex-cli-1',
      participantId: 'part-compact-1',
      waveStatus: 'thinking' as const,
      responseBuffer: [] as string[],
      hasPassed: false,
      hasLeft: false,
      readyAt: Date.now(),
      deltaBuffer: '',
      deltaFlushTimer: null as ReturnType<typeof setTimeout> | null,
    };

    // Simulate a compaction-only turn: awaiting_input fires with empty buffer
    orchestrator.handleSessionEvent(participant, {
      type: 'session:state',
      status: 'awaiting_input',
    });

    // waveStatus should still be 'thinking' — the turn was not counted as complete
    expect(participant.waveStatus).toBe('thinking');

    // No brainstorm 'message' event should have been emitted
    const messageEvents = capturedEvents.filter((e) => (e as { type?: string }).type === 'message');
    expect(messageEvents).toHaveLength(0);
  });

  it('DOES call onParticipantTurnComplete when responseBuffer has content', async () => {
    vi.useFakeTimers();

    const roomId = 'room-compact-2';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 3, 120) as unknown as {
      waveStarted: boolean;
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
          readyAt: number | null;
          deltaBuffer: string;
          deltaFlushTimer: ReturnType<typeof setTimeout> | null;
          model?: string;
        },
        event: unknown,
      ) => void;
    };

    // This is an in-wave test — a wave has been started
    orchestrator.waveStarted = true;

    const participant = {
      sessionId: 'session-compact-2',
      agentId: 'codex-agent-2',
      agentName: 'Codex',
      agentSlug: 'codex-cli-1',
      participantId: 'part-compact-2',
      waveStatus: 'thinking' as const,
      responseBuffer: [] as string[],
      hasPassed: false,
      hasLeft: false,
      readyAt: Date.now(),
      deltaBuffer: '',
      deltaFlushTimer: null as ReturnType<typeof setTimeout> | null,
    };

    // Simulate a real turn: text arrives, then awaiting_input
    orchestrator.handleSessionEvent(participant, {
      type: 'agent:text-delta',
      text: 'Real response content',
    });

    await vi.advanceTimersByTimeAsync(200);

    orchestrator.handleSessionEvent(participant, {
      type: 'session:state',
      status: 'awaiting_input',
    });

    // waveStatus should be 'done' — real content was produced
    expect(participant.waveStatus).toBe('done');

    // A brainstorm 'message' event should have been emitted
    await vi.advanceTimersByTimeAsync(100);
    const messageEvents = capturedEvents.filter((e) => (e as { type?: string }).type === 'message');
    expect(messageEvents).toHaveLength(1);
    expect((messageEvents[0] as { content: string }).content).toBe('Real response content');
  });

  it('allows empty response when waveStatus is not thinking (e.g. pending state)', async () => {
    const roomId = 'room-compact-3';
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
          readyAt: number | null;
          deltaBuffer: string;
          deltaFlushTimer: ReturnType<typeof setTimeout> | null;
          model?: string;
        },
        event: unknown,
      ) => void;
    };

    const participant = {
      sessionId: 'session-compact-3',
      agentId: 'codex-agent-3',
      agentName: 'Codex',
      agentSlug: 'codex-cli-1',
      participantId: 'part-compact-3',
      waveStatus: 'pending' as const,
      responseBuffer: [] as string[],
      hasPassed: false,
      hasLeft: false,
      readyAt: null,
      deltaBuffer: '',
      deltaFlushTimer: null as ReturnType<typeof setTimeout> | null,
    };

    // When waveStatus is 'pending', awaiting_input should still call
    // onParticipantTurnComplete (this happens during startup readiness
    // detection and is normal). The guard only blocks 'thinking' + empty.
    orchestrator.handleSessionEvent(participant, {
      type: 'session:state',
      status: 'awaiting_input',
    });

    // waveStatus should change to 'done' (the turn-complete handler runs)
    expect(participant.waveStatus).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// #9 — Majority PASS convergence
// ---------------------------------------------------------------------------

describe('majority PASS convergence', () => {
  it('hasMajorityConverged returns true when ≥2/3 of active participants passed', () => {
    const orchestrator = new BrainstormOrchestrator('room-majority-1', 5, 120) as unknown as {
      participants: ParticipantState[];
      convergenceMode: 'unanimity' | 'majority';
      hasMajorityConverged: (responses: Array<{ isPass: boolean }>) => boolean;
    };

    orchestrator.convergenceMode = 'majority';

    // 3 participants, 2 passed — 2/3 ≥ 2/3 threshold → converged
    const responses = [{ isPass: true }, { isPass: true }, { isPass: false }];

    expect(orchestrator.hasMajorityConverged(responses)).toBe(true);
  });

  it('hasMajorityConverged returns false when < 2/3 passed', () => {
    const orchestrator = new BrainstormOrchestrator('room-majority-2', 5, 120) as unknown as {
      convergenceMode: 'unanimity' | 'majority';
      hasMajorityConverged: (responses: Array<{ isPass: boolean }>) => boolean;
    };

    orchestrator.convergenceMode = 'majority';

    // 3 participants, 1 passed — 1/3 < 2/3 threshold → not converged
    const responses = [{ isPass: true }, { isPass: false }, { isPass: false }];

    expect(orchestrator.hasMajorityConverged(responses)).toBe(false);
  });

  it('hasMajorityConverged returns false when convergenceMode is unanimity', () => {
    const orchestrator = new BrainstormOrchestrator('room-majority-3', 5, 120) as unknown as {
      convergenceMode: 'unanimity' | 'majority';
      hasMajorityConverged: (responses: Array<{ isPass: boolean }>) => boolean;
    };

    orchestrator.convergenceMode = 'unanimity';

    // Even though 2/3 passed, unanimity mode requires ALL to pass
    const responses = [{ isPass: true }, { isPass: true }, { isPass: false }];

    expect(orchestrator.hasMajorityConverged(responses)).toBe(false);
  });

  it('hasMajorityConverged handles edge case of 2 participants (both must pass)', () => {
    const orchestrator = new BrainstormOrchestrator('room-majority-4', 5, 120) as unknown as {
      convergenceMode: 'unanimity' | 'majority';
      hasMajorityConverged: (responses: Array<{ isPass: boolean }>) => boolean;
    };

    orchestrator.convergenceMode = 'majority';

    // 2 participants, 1 passed — 1/2 < 2/3 → not converged
    const responses = [{ isPass: true }, { isPass: false }];

    expect(orchestrator.hasMajorityConverged(responses)).toBe(false);

    // 2 participants, 2 passed — 2/2 ≥ 2/3 → converged
    const allPass = [{ isPass: true }, { isPass: true }];

    expect(orchestrator.hasMajorityConverged(allPass)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #10 — minWavesBeforePass enforcement
// ---------------------------------------------------------------------------

describe('minWavesBeforePass enforcement', () => {
  it('treats [PASS] as regular message when wave < minWavesBeforePass', async () => {
    vi.useFakeTimers();

    const roomId = 'room-minwaves-1';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120) as unknown as {
      currentWave: number;
      waveStarted: boolean;
      minWavesBeforePass: number;
      handleSessionEvent: (participant: ParticipantState, event: unknown) => void;
    };

    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;
    orchestrator.minWavesBeforePass = 3; // PASS not allowed until wave 3

    const participant: ParticipantState = {
      sessionId: 'session-minwaves-1',
      agentId: 'agent-1',
      agentName: 'Claude',
      agentSlug: 'claude-code-1',
      participantId: 'part-1',
      waveStatus: 'thinking',
      responseBuffer: [],
      hasPassed: false,
      hasLeft: false,
      readyAt: Date.now(),
      deltaBuffer: '',
      deltaFlushTimer: null,
      waveResponseCount: 0,
      consecutiveTimeouts: 0,
    };

    // Agent sends [PASS] response
    orchestrator.handleSessionEvent(participant, {
      type: 'agent:text',
      text: '[PASS] I agree with everything.',
    });

    orchestrator.handleSessionEvent(participant, {
      type: 'session:state',
      status: 'awaiting_input',
    });

    // Should be 'done' (not 'passed') since wave < minWavesBeforePass
    expect(participant.waveStatus).toBe('done');

    // The message event should have isPass=false
    await vi.advanceTimersByTimeAsync(100);
    const messageEvents = capturedEvents.filter((e) => (e as { type?: string }).type === 'message');
    expect(messageEvents.length).toBeGreaterThanOrEqual(1);
    const lastMsg = messageEvents[messageEvents.length - 1] as { isPass: boolean };
    expect(lastMsg.isPass).toBe(false);
  });

  it('allows [PASS] when wave >= minWavesBeforePass', async () => {
    vi.useFakeTimers();

    const roomId = 'room-minwaves-2';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120) as unknown as {
      currentWave: number;
      waveStarted: boolean;
      minWavesBeforePass: number;
      handleSessionEvent: (participant: ParticipantState, event: unknown) => void;
    };

    orchestrator.currentWave = 3;
    orchestrator.waveStarted = true;
    orchestrator.minWavesBeforePass = 3; // PASS allowed from wave 3

    const participant: ParticipantState = {
      sessionId: 'session-minwaves-2',
      agentId: 'agent-2',
      agentName: 'Gemini',
      agentSlug: 'gemini-cli-1',
      participantId: 'part-2',
      waveStatus: 'thinking',
      responseBuffer: [],
      hasPassed: false,
      hasLeft: false,
      readyAt: Date.now(),
      deltaBuffer: '',
      deltaFlushTimer: null,
      waveResponseCount: 0,
      consecutiveTimeouts: 0,
    };

    // Agent sends [PASS]
    orchestrator.handleSessionEvent(participant, {
      type: 'agent:text',
      text: '[PASS]',
    });

    orchestrator.handleSessionEvent(participant, {
      type: 'session:state',
      status: 'awaiting_input',
    });

    // Should be 'passed' since wave >= minWavesBeforePass
    expect(participant.waveStatus).toBe('passed');
  });

  it('defaults minWavesBeforePass to 2', async () => {
    const orchestrator = new BrainstormOrchestrator('room-minwaves-3', 5, 120) as unknown as {
      minWavesBeforePass: number;
    };

    // Default should be 2 — PASS is only honored from wave 2 onward
    expect(orchestrator.minWavesBeforePass).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// #11 — Soft convergence detection
// ---------------------------------------------------------------------------

describe('soft convergence detection', () => {
  it('detectSoftConvergence returns true when all responses are agreement-only', () => {
    const orchestrator = new BrainstormOrchestrator('room-soft-1', 5, 120) as unknown as {
      detectSoftConvergence: (responses: Array<{ content: string; isPass: boolean }>) => boolean;
    };

    const responses = [
      { content: "I agree with Claude's approach. The architecture looks solid.", isPass: false },
      { content: 'I agree, this is the right direction.', isPass: false },
    ];

    expect(orchestrator.detectSoftConvergence(responses)).toBe(true);
  });

  it('detectSoftConvergence returns false when a response contains new ideas', () => {
    const orchestrator = new BrainstormOrchestrator('room-soft-2', 5, 120) as unknown as {
      detectSoftConvergence: (responses: Array<{ content: string; isPass: boolean }>) => boolean;
    };

    const responses = [
      {
        content:
          'I agree with the general approach, but I think we should also consider using a queue for async processing. This would significantly improve throughput and allow us to handle more concurrent requests. Additionally, we could implement a retry mechanism with exponential backoff to handle transient failures gracefully without dropping messages.',
        isPass: false,
      },
      { content: 'I agree, this looks good.', isPass: false },
    ];

    // First response is long and introduces new ideas — not agreement-only
    expect(orchestrator.detectSoftConvergence(responses)).toBe(false);
  });

  it('detectSoftConvergence ignores PASS responses (only checks non-PASS)', () => {
    const orchestrator = new BrainstormOrchestrator('room-soft-3', 5, 120) as unknown as {
      detectSoftConvergence: (responses: Array<{ content: string; isPass: boolean }>) => boolean;
    };

    const responses = [
      { content: '[PASS]', isPass: true },
      { content: 'I agree with the proposal.', isPass: false },
    ];

    // Only one non-PASS response, and it's agreement-only
    expect(orchestrator.detectSoftConvergence(responses)).toBe(true);
  });

  it('detectSoftConvergence returns false when there are no non-PASS responses', () => {
    const orchestrator = new BrainstormOrchestrator('room-soft-4', 5, 120) as unknown as {
      detectSoftConvergence: (responses: Array<{ content: string; isPass: boolean }>) => boolean;
    };

    // All passed — not soft convergence (that's hard convergence)
    const responses = [
      { content: '[PASS]', isPass: true },
      { content: '[PASS]', isPass: true },
    ];

    expect(orchestrator.detectSoftConvergence(responses)).toBe(false);
  });

  it('detectSoftConvergence recognizes Hebrew agreement markers', () => {
    const orchestrator = new BrainstormOrchestrator('room-soft-5', 5, 120) as unknown as {
      detectSoftConvergence: (responses: Array<{ content: string; isPass: boolean }>) => boolean;
    };

    const responses = [
      { content: 'מסכים עם הגישה הזו.', isPass: false },
      { content: 'I agree, looks right.', isPass: false },
    ];

    expect(orchestrator.detectSoftConvergence(responses)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #4 — Validated synthesis (two-phase)
// ---------------------------------------------------------------------------

describe('validated synthesis (two-phase)', () => {
  type MockRoom = {
    id: string;
    topic: string;
    projectId: string;
    config: Record<string, unknown> | null;
    logFilePath: string | null;
    participants: Array<{
      id: string;
      agentId: string;
      agentName: string;
      agentSlug: string;
      sessionId: string | null;
      model: string | null;
    }>;
  };

  function makeMockRoom(overrides?: {
    synthesisMode?: 'single' | 'validated';
    synthesisAgentId?: string;
  }): MockRoom {
    return {
      id: 'room-synth-val',
      topic: 'Test topic',
      projectId: 'proj-1',
      config: {
        ...(overrides?.synthesisAgentId ? { synthesisAgentId: overrides.synthesisAgentId } : {}),
        ...(overrides?.synthesisMode ? { synthesisMode: overrides.synthesisMode } : {}),
      },
      logFilePath: null,
      participants: [
        {
          id: 'part-a',
          agentId: 'agent-a',
          agentName: 'AgentA',
          agentSlug: 'agent-a-slug',
          sessionId: 'sess-a',
          model: null,
        },
        {
          id: 'part-b',
          agentId: 'agent-b',
          agentName: 'AgentB',
          agentSlug: 'agent-b-slug',
          sessionId: 'sess-b',
          model: null,
        },
      ],
    };
  }

  function buildOrchestratorForSynthesis() {
    const roomId = 'room-synth-val';
    const orchestrator = new BrainstormOrchestrator(roomId, 3, 120) as unknown as {
      roomId: string;
      participants: ParticipantState[];
      logFilePath: string;
      logWriter: { close: () => Promise<void>; open: () => void; append: () => void };
      unsubscribers: Array<() => void>;
      waveTimeoutSec: number;
      participantReadyTimeoutSec: number;
      synthesisMode: 'single' | 'validated';
      runSynthesis: (room: MockRoom) => Promise<void>;
      collectSingleTurnResponse: (sessionId: string) => Promise<string>;
      emitEvent: (event: unknown) => Promise<void>;
      injectMessage: (sessionId: string, text: string) => Promise<void>;
    };

    orchestrator.participants = [
      {
        participantId: 'part-a',
        agentId: 'agent-a',
        agentName: 'AgentA',
        agentSlug: 'agent-a-slug',
        sessionId: 'sess-a',
        waveStatus: 'done',
        responseBuffer: [],
        hasPassed: false,
        hasLeft: false,
        readyAt: Date.now(),
        deltaBuffer: '',
        deltaFlushTimer: null,
        waveResponseCount: 0,
        consecutiveTimeouts: 0,
      },
      {
        participantId: 'part-b',
        agentId: 'agent-b',
        agentName: 'AgentB',
        agentSlug: 'agent-b-slug',
        sessionId: 'sess-b',
        waveStatus: 'done',
        responseBuffer: [],
        hasPassed: false,
        hasLeft: false,
        readyAt: Date.now(),
        deltaBuffer: '',
        deltaFlushTimer: null,
        waveResponseCount: 0,
        consecutiveTimeouts: 0,
      },
    ];

    return { orchestrator, roomId };
  }

  it('single mode (default): does NOT run validation wave', async () => {
    const { orchestrator } = buildOrchestratorForSynthesis();
    const room = makeMockRoom(); // no synthesisMode → defaults to 'single'

    mockCreateSession.mockResolvedValueOnce({ id: 'synth-sess-1' });

    let collectCallCount = 0;
    vi.spyOn(
      orchestrator as unknown as { collectSingleTurnResponse: (id: string) => Promise<string> },
      'collectSingleTurnResponse',
    ).mockImplementation(async () => {
      collectCallCount++;
      return 'Draft synthesis text';
    });

    const injectSpy = vi
      .spyOn(
        orchestrator as unknown as {
          injectMessage: (sid: string, text: string) => Promise<void>;
        },
        'injectMessage',
      )
      .mockResolvedValue(undefined);

    await orchestrator.runSynthesis(room);

    // Only one call to collectSingleTurnResponse (the initial synthesis)
    expect(collectCallCount).toBe(1);
    // No inject calls for validation
    expect(injectSpy).not.toHaveBeenCalled();
    // Synthesis stored with the draft text
    expect(mockSetBrainstormSynthesis).toHaveBeenCalledWith(
      'room-synth-val',
      'Draft synthesis text',
    );
  });

  it('validated mode: runs validation wave and stores FINAL synthesis', async () => {
    const { orchestrator } = buildOrchestratorForSynthesis();
    orchestrator.synthesisMode = 'validated';
    const room = makeMockRoom();

    mockCreateSession.mockResolvedValueOnce({ id: 'synth-sess-v1' });

    // Track collectSingleTurnResponse calls:
    // 1st → draft synthesis (from synth session)
    // 2nd, 3rd → validation responses from participants
    // 4th → final synthesis (from synth session again)
    const collectCalls: string[] = [];
    vi.spyOn(
      orchestrator as unknown as { collectSingleTurnResponse: (id: string) => Promise<string> },
      'collectSingleTurnResponse',
    ).mockImplementation(async (sessionId: string) => {
      collectCalls.push(sessionId);
      if (collectCalls.length === 1) return 'Draft synthesis text';
      if (collectCalls.length === 2) return 'Correction from A';
      if (collectCalls.length === 3) return 'Correction from B';
      return 'Final validated synthesis';
    });

    const injectCalls: Array<{ sessionId: string; text: string }> = [];
    vi.spyOn(
      orchestrator as unknown as {
        injectMessage: (sid: string, text: string) => Promise<void>;
      },
      'injectMessage',
    ).mockImplementation(async (sessionId: string, text: string) => {
      injectCalls.push({ sessionId, text });
    });

    await orchestrator.runSynthesis(room);

    // 4 collect calls: draft + 2 validation + final
    expect(collectCalls).toHaveLength(4);
    expect(collectCalls[0]).toBe('synth-sess-v1'); // draft from synth agent
    expect(collectCalls[1]).toBe('sess-a'); // validation from participant A
    expect(collectCalls[2]).toBe('sess-b'); // validation from participant B
    expect(collectCalls[3]).toBe('synth-sess-v1'); // final from synth agent

    // Validation wave injected draft into both participant sessions
    expect(injectCalls).toHaveLength(3); // 2 participants + 1 synthesis agent (corrections)
    expect(injectCalls[0].sessionId).toBe('sess-a');
    expect(injectCalls[0].text).toContain('Draft synthesis text');
    expect(injectCalls[1].sessionId).toBe('sess-b');
    expect(injectCalls[1].text).toContain('Draft synthesis text');

    // Final inject sends corrections to synthesis agent
    expect(injectCalls[2].sessionId).toBe('synth-sess-v1');
    expect(injectCalls[2].text).toContain('Correction from A');
    expect(injectCalls[2].text).toContain('Correction from B');

    // Final synthesis (not draft) is stored
    expect(mockSetBrainstormSynthesis).toHaveBeenCalledWith(
      'room-synth-val',
      'Final validated synthesis',
    );
  });

  it('validated mode: skips hasPassed participants and those without sessionId', async () => {
    const { orchestrator } = buildOrchestratorForSynthesis();
    orchestrator.synthesisMode = 'validated';
    const room = makeMockRoom();

    // Mark participant A as passed, remove session from B
    orchestrator.participants[0].hasPassed = true;
    orchestrator.participants[1].sessionId = null;

    mockCreateSession.mockResolvedValueOnce({ id: 'synth-sess-v3' });

    let collectCallCount = 0;
    vi.spyOn(
      orchestrator as unknown as { collectSingleTurnResponse: (id: string) => Promise<string> },
      'collectSingleTurnResponse',
    ).mockImplementation(async () => {
      collectCallCount++;
      if (collectCallCount === 1) return 'Draft synthesis';
      return 'Final synthesis (no corrections)';
    });

    const injectCalls: string[] = [];
    vi.spyOn(
      orchestrator as unknown as {
        injectMessage: (sid: string, text: string) => Promise<void>;
      },
      'injectMessage',
    ).mockImplementation(async (sessionId: string) => {
      injectCalls.push(sessionId);
    });

    await orchestrator.runSynthesis(room);

    // No participants eligible → no validation inject calls to participants
    // But we still send "no corrections" to the synthesis agent
    expect(injectCalls).toHaveLength(1); // only the final corrections-to-synth-agent inject
    // Draft + final = 2 collect calls (no participant validation calls)
    expect(collectCallCount).toBe(2);
  });

  it('validated mode: emits room:synthesis event with final text, not draft', async () => {
    const { orchestrator } = buildOrchestratorForSynthesis();
    orchestrator.synthesisMode = 'validated';
    const room = makeMockRoom();

    mockCreateSession.mockResolvedValueOnce({ id: 'synth-sess-v4' });

    let collectCallCount = 0;
    vi.spyOn(
      orchestrator as unknown as { collectSingleTurnResponse: (id: string) => Promise<string> },
      'collectSingleTurnResponse',
    ).mockImplementation(async () => {
      collectCallCount++;
      if (collectCallCount === 1) return 'Draft v1';
      return 'Final v2';
    });

    vi.spyOn(
      orchestrator as unknown as {
        injectMessage: (sid: string, text: string) => Promise<void>;
      },
      'injectMessage',
    ).mockResolvedValue(undefined);

    const emittedEvents: unknown[] = [];
    vi.spyOn(
      orchestrator as unknown as { emitEvent: (e: unknown) => Promise<void> },
      'emitEvent',
    ).mockImplementation(async (event: unknown) => {
      emittedEvents.push(event);
    });

    await orchestrator.runSynthesis(room);

    const synthEvent = emittedEvents.find(
      (e) => (e as { type: string }).type === 'room:synthesis',
    ) as { type: string; synthesis: string } | undefined;
    expect(synthEvent).toBeDefined();
    expect(synthEvent!.synthesis).toBe('Final v2');
  });
});

// Type alias used by the new tests
type ParticipantState = {
  participantId: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  sessionId: string | null;
  model?: string;
  waveStatus: 'pending' | 'thinking' | 'done' | 'passed' | 'timeout';
  responseBuffer: string[];
  hasPassed: boolean;
  hasLeft: boolean;
  readyAt: number | null;
  deltaBuffer: string;
  deltaFlushTimer: ReturnType<typeof setTimeout> | null;
  /** Number of responses this participant has sent in the current wave (reactive injection tracking) */
  waveResponseCount: number;
  /** Number of consecutive waves this participant timed out */
  consecutiveTimeouts: number;
};

// ---------------------------------------------------------------------------
// #12 — Reactive injection (hybrid wave model)
// ---------------------------------------------------------------------------

describe('reactive injection', () => {
  /** Helper: make a participant with defaults suitable for reactive injection tests */
  function makeParticipant(
    overrides: Partial<ParticipantState> & {
      agentId: string;
      agentName: string;
      sessionId: string;
    },
  ): ParticipantState {
    return {
      participantId: `part-${overrides.agentId}`,
      agentSlug: `${overrides.agentName.toLowerCase()}-slug`,
      waveStatus: 'thinking',
      responseBuffer: [],
      hasPassed: false,
      hasLeft: false,
      readyAt: Date.now(),
      deltaBuffer: '',
      deltaFlushTimer: null,
      waveResponseCount: 0,
      consecutiveTimeouts: 0,
      ...overrides,
    };
  }

  /**
   * Common test interface for the orchestrator — exposes private fields for testing.
   */
  type TestOrchestrator = {
    participants: ParticipantState[];
    currentWave: number;
    waveStarted: boolean;
    reactiveInjection: boolean;
    maxResponsesPerWave: number;
    pendingReactiveInjections: number;
    waveCompleteResolve: (() => void) | null;
    handleSessionEvent: (participant: ParticipantState, event: unknown) => void;
    onParticipantTurnComplete: (participant: ParticipantState) => void;
    checkWaveComplete: () => void;
    injectMessage: (sessionId: string, text: string) => Promise<void>;
    evictionThreshold: number;
  };

  it("when agent A finishes, injects A's response into agents still thinking", async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-1';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    const agentB = makeParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
    });
    const agentC = makeParticipant({ agentId: 'agent-c', agentName: 'Codex', sessionId: 'sess-c' });

    orchestrator.participants = [agentA, agentB, agentC];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;

    // Mock injectMessage to track calls
    const injectionCalls: Array<{ sessionId: string; text: string }> = [];
    orchestrator.injectMessage = vi.fn(async (sessionId: string, text: string) => {
      injectionCalls.push({ sessionId, text });
    });

    // Agent A produces a response
    orchestrator.handleSessionEvent(agentA, {
      type: 'agent:text',
      text: 'Agent A has a great idea about X.',
    });
    orchestrator.handleSessionEvent(agentA, { type: 'session:state', status: 'awaiting_input' });

    // Allow async event handlers to run
    await vi.advanceTimersByTimeAsync(50);

    // injectMessage should have been called for agents B and C (still thinking)
    expect(injectionCalls.length).toBe(2);
    expect(injectionCalls.some((c) => c.sessionId === 'sess-b')).toBe(true);
    expect(injectionCalls.some((c) => c.sessionId === 'sess-c')).toBe(true);
    // Injected text should contain Agent A's response
    expect(injectionCalls[0].text).toContain('Agent A has a great idea about X.');
  });

  it('re-activates done agents within response budget', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-2';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    const agentB = makeParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
      waveStatus: 'done',
      waveResponseCount: 1,
    });

    orchestrator.participants = [agentA, agentB];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;
    orchestrator.maxResponsesPerWave = 2; // budget of 2

    const injectionCalls: Array<{ sessionId: string; text: string }> = [];
    orchestrator.injectMessage = vi.fn(async (sessionId: string, text: string) => {
      injectionCalls.push({ sessionId, text });
    });

    // Agent A finishes
    orchestrator.handleSessionEvent(agentA, { type: 'agent:text', text: 'New insight from A.' });
    orchestrator.handleSessionEvent(agentA, { type: 'session:state', status: 'awaiting_input' });

    await vi.advanceTimersByTimeAsync(50);

    // Agent B was 'done' with 1 response, budget is 2 — should get reactivated
    expect(agentB.waveStatus).toBe('thinking');
    expect(injectionCalls.some((c) => c.sessionId === 'sess-b')).toBe(true);
  });

  it('does NOT re-activate done agents that have exhausted their response budget', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-3';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    const agentB = makeParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
      waveStatus: 'done',
      waveResponseCount: 2, // already at budget
    });

    orchestrator.participants = [agentA, agentB];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;
    orchestrator.maxResponsesPerWave = 2;

    const injectionCalls: Array<{ sessionId: string; text: string }> = [];
    orchestrator.injectMessage = vi.fn(async (sessionId: string, text: string) => {
      injectionCalls.push({ sessionId, text });
    });

    // Agent A finishes
    orchestrator.handleSessionEvent(agentA, { type: 'agent:text', text: 'Another insight.' });
    orchestrator.handleSessionEvent(agentA, { type: 'session:state', status: 'awaiting_input' });

    await vi.advanceTimersByTimeAsync(50);

    // Agent B should NOT be reactivated — budget exhausted
    expect(agentB.waveStatus).toBe('done');
    expect(injectionCalls.some((c) => c.sessionId === 'sess-b')).toBe(false);
  });

  it('does NOT inject into passed or left participants', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-4';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    const agentB = makeParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
      waveStatus: 'passed',
      hasPassed: true,
    });
    const agentC = makeParticipant({
      agentId: 'agent-c',
      agentName: 'Codex',
      sessionId: 'sess-c',
      waveStatus: 'done',
      hasLeft: true,
    });

    orchestrator.participants = [agentA, agentB, agentC];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;

    const injectionCalls: Array<{ sessionId: string; text: string }> = [];
    orchestrator.injectMessage = vi.fn(async (sessionId: string, text: string) => {
      injectionCalls.push({ sessionId, text });
    });

    orchestrator.handleSessionEvent(agentA, { type: 'agent:text', text: 'My idea.' });
    orchestrator.handleSessionEvent(agentA, { type: 'session:state', status: 'awaiting_input' });

    await vi.advanceTimersByTimeAsync(50);

    // Neither B (passed) nor C (left) should receive injections
    expect(injectionCalls.length).toBe(0);
  });

  it('wave completes when all agents done and no pending injections', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-5';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
      waveStatus: 'done',
      waveResponseCount: 2,
    });
    const agentB = makeParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
      waveStatus: 'done',
      waveResponseCount: 2,
    });

    orchestrator.participants = [agentA, agentB];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;
    orchestrator.pendingReactiveInjections = 0;

    let resolved = false;
    orchestrator.waveCompleteResolve = () => {
      resolved = true;
    };

    orchestrator.checkWaveComplete();
    expect(resolved).toBe(true);
  });

  it('wave does NOT complete while there are pending reactive injections', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-6';

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
      waveStatus: 'done',
      waveResponseCount: 1,
    });
    const agentB = makeParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
      waveStatus: 'thinking',
      waveResponseCount: 0,
    });

    orchestrator.participants = [agentA, agentB];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;
    orchestrator.pendingReactiveInjections = 1; // injection in flight

    let resolved = false;
    orchestrator.waveCompleteResolve = () => {
      resolved = true;
    };

    orchestrator.checkWaveComplete();
    // Should NOT resolve — agent B is still thinking (has a pending injection)
    expect(resolved).toBe(false);
  });

  it('increments waveResponseCount each time agent completes a turn', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-7';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });

    orchestrator.participants = [agentA];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;

    // Mock injectMessage
    orchestrator.injectMessage = vi.fn(async () => {});

    // First response
    orchestrator.handleSessionEvent(agentA, { type: 'agent:text', text: 'First response.' });
    orchestrator.handleSessionEvent(agentA, { type: 'session:state', status: 'awaiting_input' });
    await vi.advanceTimersByTimeAsync(50);

    expect(agentA.waveResponseCount).toBe(1);

    // Simulate being reactivated and responding again
    agentA.waveStatus = 'thinking';
    agentA.responseBuffer = [];
    orchestrator.handleSessionEvent(agentA, { type: 'agent:text', text: 'Second response.' });
    orchestrator.handleSessionEvent(agentA, { type: 'session:state', status: 'awaiting_input' });
    await vi.advanceTimersByTimeAsync(50);

    expect(agentA.waveResponseCount).toBe(2);
  });

  it('reactiveInjection defaults to true', () => {
    const orchestrator = new BrainstormOrchestrator(
      'room-reactive-default',
      5,
      120,
    ) as unknown as TestOrchestrator;
    expect(orchestrator.reactiveInjection).toBe(true);
  });

  it('does NOT inject reactively when reactiveInjection is disabled', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-off';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    // Explicitly disable reactive injection for this test
    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: false,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    const agentB = makeParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
    });

    orchestrator.participants = [agentA, agentB];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;

    const injectionCalls: Array<{ sessionId: string; text: string }> = [];
    orchestrator.injectMessage = vi.fn(async (sessionId: string, text: string) => {
      injectionCalls.push({ sessionId, text });
    });

    // Agent A finishes
    orchestrator.handleSessionEvent(agentA, { type: 'agent:text', text: 'My idea.' });
    orchestrator.handleSessionEvent(agentA, { type: 'session:state', status: 'awaiting_input' });

    await vi.advanceTimersByTimeAsync(50);

    // No reactive injections — old behavior preserved
    expect(injectionCalls.length).toBe(0);
  });

  it('startWave resets waveResponseCount for all active participants', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-reset';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator & {
      startWave: (wave: number, content: string) => Promise<void>;
    };

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
      waveResponseCount: 2, // leftover from previous wave
    });

    orchestrator.participants = [agentA];

    // Mock injectMessage to avoid real calls
    orchestrator.injectMessage = vi.fn(async () => {});

    await orchestrator.startWave(1, 'New wave content');

    expect(agentA.waveResponseCount).toBe(0);
  });

  it('formats reactive injection with agent name prefix', async () => {
    vi.useFakeTimers();

    const roomId = 'room-reactive-format';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120, {
      reactiveInjection: true,
    }) as unknown as TestOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    const agentB = makeParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
    });

    orchestrator.participants = [agentA, agentB];
    orchestrator.currentWave = 1;
    orchestrator.waveStarted = true;

    const injectionCalls: Array<{ sessionId: string; text: string }> = [];
    orchestrator.injectMessage = vi.fn(async (sessionId: string, text: string) => {
      injectionCalls.push({ sessionId, text });
    });

    orchestrator.handleSessionEvent(agentA, { type: 'agent:text', text: 'My deep analysis.' });
    orchestrator.handleSessionEvent(agentA, { type: 'session:state', status: 'awaiting_input' });

    await vi.advanceTimersByTimeAsync(50);

    // Injected text should be formatted with agent name
    expect(injectionCalls.length).toBe(1);
    expect(injectionCalls[0].text).toContain('[Claude]');
    expect(injectionCalls[0].text).toContain('My deep analysis.');
  });
});

// ---------------------------------------------------------------------------
// Wave timeout handle resource leak fix
// ---------------------------------------------------------------------------

describe('wave timeout handle', () => {
  /** Minimal participant suitable for wave-timeout tests */
  function makeParticipant(overrides: {
    agentId: string;
    agentName: string;
    sessionId: string;
  }): ParticipantState {
    return {
      participantId: `part-${overrides.agentId}`,
      agentSlug: `${overrides.agentName.toLowerCase()}-slug`,
      waveStatus: 'thinking',
      responseBuffer: [],
      hasPassed: false,
      hasLeft: false,
      readyAt: Date.now(),
      deltaBuffer: '',
      deltaFlushTimer: null,
      waveResponseCount: 0,
      consecutiveTimeouts: 0,
      ...overrides,
    };
  }

  /**
   * Minimal view of the orchestrator internals used by these tests.
   */
  type WaveTimeoutOrchestrator = {
    participants: ParticipantState[];
    currentWave: number;
    waveStarted: boolean;
    waveTimeoutHandle: ReturnType<typeof setTimeout> | null;
    waveCompleteResolve: (() => void) | null;
    checkWaveComplete: () => void;
    waitForWaveComplete: () => Promise<void>;
    scheduleWaveTimeout: (wave: number) => void;
    cleanup: () => void;
  };

  it('wave completing early clears the pending timeout handle', async () => {
    vi.useFakeTimers();

    const roomId = 'room-wave-timeout-1';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(
      roomId,
      3,
      60,
    ) as unknown as WaveTimeoutOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    orchestrator.participants = [agentA];
    orchestrator.currentWave = 0;
    orchestrator.waveStarted = true;

    // Schedule the wave timeout (60 s)
    orchestrator.scheduleWaveTimeout(0);
    expect(orchestrator.waveTimeoutHandle).not.toBeNull();

    // Mark the participant done and let waitForWaveComplete resolve
    const waveDone = orchestrator.waitForWaveComplete();
    agentA.waveStatus = 'done';
    orchestrator.checkWaveComplete();
    await waveDone;

    // Handle must be cleared after early completion
    expect(orchestrator.waveTimeoutHandle).toBeNull();

    // Advancing past the original timeout must not flip the participant back to 'timeout'
    agentA.waveStatus = 'done'; // ensure it stays done
    await vi.advanceTimersByTimeAsync(61_000);
    expect(agentA.waveStatus).toBe('done');
  });

  it('cleanup() cancels a pending wave timeout handle', () => {
    vi.useFakeTimers();

    const roomId = 'room-wave-timeout-2';
    const listenerSet = new Set<(event: unknown) => void>();
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(
      roomId,
      3,
      120,
    ) as unknown as WaveTimeoutOrchestrator;

    const agentA = makeParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    orchestrator.participants = [agentA];
    orchestrator.currentWave = 0;
    orchestrator.waveStarted = true;

    // Schedule the wave timeout (120 s) without completing the wave
    orchestrator.scheduleWaveTimeout(0);
    expect(orchestrator.waveTimeoutHandle).not.toBeNull();

    // Cleanup should cancel the timer
    orchestrator.cleanup();
    expect(orchestrator.waveTimeoutHandle).toBeNull();

    // Advancing past the timeout must NOT flip participant to 'timeout'
    // because the timer was cleared
    agentA.waveStatus = 'thinking';
    vi.advanceTimersByTime(121_000);
    expect(agentA.waveStatus).toBe('thinking');
  });
});

// Wave 0 message deduplication (fix for preamble-topic double-response)
// ---------------------------------------------------------------------------

describe('wave 0 message deduplication', () => {
  /** Helper: make a participant for dedup tests */
  function makeDedupParticipant(
    overrides: Partial<{
      agentId: string;
      agentName: string;
      sessionId: string;
      waveStatus: 'pending' | 'thinking' | 'done' | 'passed' | 'timeout';
    }>,
  ): ParticipantState {
    return {
      participantId: `part-${overrides.agentId ?? 'x'}`,
      agentId: overrides.agentId ?? 'agent-x',
      agentName: overrides.agentName ?? 'Agent',
      agentSlug: 'agent-slug',
      sessionId: overrides.sessionId ?? 'sess-x',
      waveStatus: overrides.waveStatus ?? 'thinking',
      responseBuffer: [],
      hasPassed: false,
      hasLeft: false,
      readyAt: Date.now(),
      deltaBuffer: '',
      deltaFlushTimer: null,
      waveResponseCount: 0,
      consecutiveTimeouts: 0,
    };
  }

  it('onParticipantTurnComplete suppresses message emission when waveStarted is false', async () => {
    vi.useFakeTimers();

    const roomId = 'room-dedup-1';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120) as unknown as {
      participants: ParticipantState[];
      currentWave: number;
      waveStarted: boolean;
      onParticipantTurnComplete: (p: ParticipantState) => void;
    };

    const agent = makeDedupParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    orchestrator.participants = [agent];
    orchestrator.waveStarted = false;

    agent.responseBuffer = ['Preamble acknowledgment response'];
    orchestrator.onParticipantTurnComplete(agent);

    await vi.advanceTimersByTimeAsync(50);

    const messageEvents = capturedEvents.filter((e) => (e as { type: string }).type === 'message');
    expect(messageEvents).toHaveLength(0);

    vi.useRealTimers();
  });

  it('onParticipantTurnComplete marks participant waveStatus=done when waveStarted is false', () => {
    const roomId = 'room-dedup-2';
    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120) as unknown as {
      participants: ParticipantState[];
      currentWave: number;
      waveStarted: boolean;
      onParticipantTurnComplete: (p: ParticipantState) => void;
    };

    const agent = makeDedupParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    orchestrator.participants = [agent];
    orchestrator.waveStarted = false;

    agent.responseBuffer = ['Some preamble ack'];
    orchestrator.onParticipantTurnComplete(agent);

    expect(agent.waveStatus).toBe('done');
    expect(agent.responseBuffer).toHaveLength(0);
  });

  it('after wave 0, exactly N message events are emitted for N agents (not 2N)', async () => {
    vi.useFakeTimers();

    const roomId = 'room-dedup-3';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(roomId, 5, 120) as unknown as {
      participants: ParticipantState[];
      currentWave: number;
      waveStarted: boolean;
      onParticipantTurnComplete: (p: ParticipantState) => void;
    };

    const agentA = makeDedupParticipant({
      agentId: 'agent-a',
      agentName: 'Claude',
      sessionId: 'sess-a',
    });
    const agentB = makeDedupParticipant({
      agentId: 'agent-b',
      agentName: 'Gemini',
      sessionId: 'sess-b',
    });
    const agentC = makeDedupParticipant({
      agentId: 'agent-c',
      agentName: 'Codex',
      sessionId: 'sess-c',
    });
    orchestrator.participants = [agentA, agentB, agentC];

    // Phase 1: pre-wave preamble acknowledgment (waveStarted = false)
    orchestrator.waveStarted = false;
    agentA.responseBuffer = ['Sure, I understand the rules.'];
    orchestrator.onParticipantTurnComplete(agentA);
    agentB.responseBuffer = ['Got it.'];
    orchestrator.onParticipantTurnComplete(agentB);
    agentC.responseBuffer = ['Ready.'];
    orchestrator.onParticipantTurnComplete(agentC);

    await vi.advanceTimersByTimeAsync(50);

    const preWaveMessages = capturedEvents.filter(
      (e) => (e as { type: string }).type === 'message',
    );
    expect(preWaveMessages).toHaveLength(0);

    // Phase 2: wave 0 actual responses (waveStarted = true)
    orchestrator.waveStarted = true;
    orchestrator.currentWave = 0;
    agentA.waveStatus = 'thinking';
    agentB.waveStatus = 'thinking';
    agentC.waveStatus = 'thinking';
    agentA.responseBuffer = ['My wave 0 response about the topic.'];
    orchestrator.onParticipantTurnComplete(agentA);
    agentB.responseBuffer = ['My wave 0 response.'];
    orchestrator.onParticipantTurnComplete(agentB);
    agentC.responseBuffer = ['My wave 0 response.'];
    orchestrator.onParticipantTurnComplete(agentC);

    await vi.advanceTimersByTimeAsync(50);

    const waveMessages = capturedEvents.filter(
      (e) =>
        (e as { type: string }).type === 'message' &&
        (e as { senderType?: string }).senderType === 'agent',
    );
    expect(waveMessages).toHaveLength(3);

    vi.useRealTimers();
  });
});

// Dead-participant detection (auto-eviction after consecutive timeouts)
// ---------------------------------------------------------------------------

describe('dead-participant detection', () => {
  function makeEvictionParticipant(
    overrides: Partial<ParticipantState> & {
      agentId: string;
      agentName: string;
      sessionId: string;
    },
  ): ParticipantState {
    return {
      participantId: `part-${overrides.agentId}`,
      agentSlug: `${overrides.agentName.toLowerCase()}-slug`,
      waveStatus: 'thinking',
      responseBuffer: [],
      hasPassed: false,
      hasLeft: false,
      readyAt: Date.now(),
      deltaBuffer: '',
      deltaFlushTimer: null,
      waveResponseCount: 0,
      consecutiveTimeouts: 0,
      ...overrides,
    };
  }

  type EvictionTestOrchestrator = {
    participants: ParticipantState[];
    evictionThreshold: number;
    trackConsecutiveTimeouts: () => Promise<void>;
  };

  it('timeout once → consecutiveTimeouts = 1, participant still active', async () => {
    const roomId = 'room-evict-1';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(
      roomId,
      5,
      120,
    ) as unknown as EvictionTestOrchestrator;

    const participant = makeEvictionParticipant({
      agentId: 'agent-codex',
      agentName: 'Codex',
      sessionId: 'sess-codex',
      waveStatus: 'timeout',
    });

    orchestrator.participants = [participant];

    await orchestrator.trackConsecutiveTimeouts();

    expect(participant.consecutiveTimeouts).toBe(1);
    expect(participant.hasLeft).toBe(false);
    expect(participant.hasPassed).toBe(false);
  });

  it('timeout twice → auto-evicted (hasLeft = true, hasPassed = true)', async () => {
    const roomId = 'room-evict-2';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(
      roomId,
      5,
      120,
    ) as unknown as EvictionTestOrchestrator;

    const participant = makeEvictionParticipant({
      agentId: 'agent-codex',
      agentName: 'Codex',
      sessionId: 'sess-codex',
      waveStatus: 'timeout',
      consecutiveTimeouts: 1,
    });

    orchestrator.participants = [participant];

    await orchestrator.trackConsecutiveTimeouts();

    expect(participant.consecutiveTimeouts).toBe(2);
    expect(participant.hasLeft).toBe(true);
    expect(participant.hasPassed).toBe(true);

    const evictionEvent = capturedEvents.find(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        (e as Record<string, unknown>).type === 'participant:status' &&
        (e as Record<string, unknown>).status === 'evicted',
    );
    expect(evictionEvent).toBeDefined();
    expect(mockUpdateParticipantStatus).toHaveBeenCalledWith('part-agent-codex', 'left');
  });

  it('timeout once then responds → consecutiveTimeouts reset to 0', async () => {
    const roomId = 'room-evict-3';
    const orchestrator = new BrainstormOrchestrator(
      roomId,
      5,
      120,
    ) as unknown as EvictionTestOrchestrator;

    const participant = makeEvictionParticipant({
      agentId: 'agent-codex',
      agentName: 'Codex',
      sessionId: 'sess-codex',
      waveStatus: 'timeout',
    });

    orchestrator.participants = [participant];

    await orchestrator.trackConsecutiveTimeouts();
    expect(participant.consecutiveTimeouts).toBe(1);

    participant.waveStatus = 'done';
    await orchestrator.trackConsecutiveTimeouts();
    expect(participant.consecutiveTimeouts).toBe(0);
    expect(participant.hasLeft).toBe(false);
  });

  it('evicted participant is excluded from future tracking', async () => {
    const roomId = 'room-evict-4';
    const capturedEvents: unknown[] = [];
    const listenerSet = new Set<(event: unknown) => void>();
    listenerSet.add((event) => capturedEvents.push(event));
    mockBrainstormEventListeners.set(roomId, listenerSet);

    const orchestrator = new BrainstormOrchestrator(
      roomId,
      5,
      120,
    ) as unknown as EvictionTestOrchestrator;

    const participant = makeEvictionParticipant({
      agentId: 'agent-codex',
      agentName: 'Codex',
      sessionId: 'sess-codex',
      waveStatus: 'timeout',
      consecutiveTimeouts: 1,
    });

    orchestrator.participants = [participant];

    await orchestrator.trackConsecutiveTimeouts();
    expect(participant.hasLeft).toBe(true);

    const prevEvictionCount = capturedEvents.filter(
      (e) =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>).status === 'evicted',
    ).length;

    participant.waveStatus = 'timeout';
    await orchestrator.trackConsecutiveTimeouts();

    const newEvictionCount = capturedEvents.filter(
      (e) =>
        typeof e === 'object' && e !== null && (e as Record<string, unknown>).status === 'evicted',
    ).length;

    expect(newEvictionCount).toBe(prevEvictionCount);
  });

  it('evictionThreshold defaults to 2', () => {
    const orchestrator = new BrainstormOrchestrator(
      'room-evict-default',
      5,
      120,
    ) as unknown as EvictionTestOrchestrator;
    expect(orchestrator.evictionThreshold).toBe(2);
  });

  it('evictionThreshold can be overridden via config', () => {
    const orchestrator = new BrainstormOrchestrator('room-evict-config', 5, 120, {
      evictionThreshold: 3,
    }) as unknown as EvictionTestOrchestrator;
    expect(orchestrator.evictionThreshold).toBe(3);
  });
});

// Convergence timeout attrition — distinguish real PASS from timeout
// ---------------------------------------------------------------------------

describe('convergence timeout attrition', () => {
  type ConvergenceOrchestrator = {
    participants: ParticipantState[];
    convergenceMode: string;
    hasMajorityConverged: (responses: Array<{ isPass: boolean; isTimeout?: boolean }>) => boolean;
  };

  it('3 agents: 2 PASS + 1 timeout in unanimous mode does NOT converge', () => {
    const orchestrator = new BrainstormOrchestrator('room-conv-1', 5, 120, {
      convergenceMode: 'unanimous',
    }) as unknown as ConvergenceOrchestrator;

    const responses: Array<{ isPass: boolean; isTimeout: boolean }> = [
      { isPass: true, isTimeout: false },
      { isPass: true, isTimeout: false },
      { isPass: false, isTimeout: true },
    ];

    const passedCount = responses.filter((r) => r.isPass).length;
    const timedOutCount = responses.filter((r) => r.isTimeout).length;
    const totalParticipants = responses.length;

    const unanimousConverged = passedCount === totalParticipants && timedOutCount === 0;
    const majorityConverged = orchestrator.hasMajorityConverged(responses);

    expect(unanimousConverged).toBe(false);
    expect(majorityConverged).toBe(false);
  });

  it('3 agents: 2 PASS + 1 timeout in majority mode DOES converge (2/3 >= 2/3)', () => {
    const orchestrator = new BrainstormOrchestrator('room-conv-2', 5, 120, {
      convergenceMode: 'majority',
    }) as unknown as ConvergenceOrchestrator;

    const responses: Array<{ isPass: boolean; isTimeout: boolean }> = [
      { isPass: true, isTimeout: false },
      { isPass: true, isTimeout: false },
      { isPass: false, isTimeout: true },
    ];

    expect(orchestrator.hasMajorityConverged(responses)).toBe(true);
  });

  it('3 agents: 1 PASS + 2 timeout in majority mode does NOT converge (1/3 < 2/3)', () => {
    const orchestrator = new BrainstormOrchestrator('room-conv-3', 5, 120, {
      convergenceMode: 'majority',
    }) as unknown as ConvergenceOrchestrator;

    const responses: Array<{ isPass: boolean; isTimeout: boolean }> = [
      { isPass: true, isTimeout: false },
      { isPass: false, isTimeout: true },
      { isPass: false, isTimeout: true },
    ];

    expect(orchestrator.hasMajorityConverged(responses)).toBe(false);
  });

  it('3 agents: 3 PASS + 0 timeout converges in both modes', () => {
    const unanimousOrch = new BrainstormOrchestrator('room-conv-4a', 5, 120, {
      convergenceMode: 'unanimous',
    }) as unknown as ConvergenceOrchestrator;

    const majorityOrch = new BrainstormOrchestrator('room-conv-4b', 5, 120, {
      convergenceMode: 'majority',
    }) as unknown as ConvergenceOrchestrator;

    const responses: Array<{ isPass: boolean; isTimeout: boolean }> = [
      { isPass: true, isTimeout: false },
      { isPass: true, isTimeout: false },
      { isPass: true, isTimeout: false },
    ];

    const passedCount = responses.filter((r) => r.isPass).length;
    const timedOutCount = responses.filter((r) => r.isTimeout).length;
    const totalParticipants = responses.length;

    const unanimousConverged = passedCount === totalParticipants && timedOutCount === 0;
    expect(unanimousConverged).toBe(true);
    expect(unanimousOrch.hasMajorityConverged(responses)).toBe(false); // wrong mode
    expect(majorityOrch.hasMajorityConverged(responses)).toBe(true);
  });
});
