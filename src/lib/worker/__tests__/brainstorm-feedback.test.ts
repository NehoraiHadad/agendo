/**
 * Tests for brainstorm feedback signals (wave:review feature)
 *
 * Tests cover:
 * - receiveFeedback() stores feedback correctly
 * - waitForFeedback() resolves after timeout
 * - waitForFeedback() resolves early when all participants respond
 * - Feedback is formatted correctly in wave broadcast
 * - reviewPauseSec=0 skips the wait entirely
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgendoEvent } from '@/lib/realtime/event-types';

// ---------------------------------------------------------------------------
// Mock: worker-sse
// ---------------------------------------------------------------------------

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
const mockGetCompletedRoomsForProject = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
  updateBrainstormStatus: mockUpdateBrainstormStatus,
  updateBrainstormWave: mockUpdateBrainstormWave,
  updateParticipantSession: mockUpdateParticipantSession,
  updateParticipantStatus: mockUpdateParticipantStatus,
  setBrainstormSynthesis: mockSetBrainstormSynthesis,
  getCompletedRoomsForProject: mockGetCompletedRoomsForProject,
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
// Mock: log-writer
// ---------------------------------------------------------------------------

vi.mock('@/lib/worker/log-writer', () => ({
  FileLogWriter: vi.fn().mockImplementation(() => ({
    open: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    writeEvent: vi.fn(),
  })),
  resolveBrainstormLogPath: vi.fn().mockReturnValue('/tmp/brainstorm-test.log'),
}));

// ---------------------------------------------------------------------------
// Mock: synthesis-decision-log
// ---------------------------------------------------------------------------

vi.mock('@/lib/worker/synthesis-decision-log', () => ({
  STRUCTURED_SYNTHESIS_PROMPT_SUFFIX: '',
  SYNTHESIS_TEMPLATES: {},
  DEFAULT_SYNTHESIS_TEMPLATE: '',
  createTasksFromSynthesis: vi.fn().mockResolvedValue([]),
}));

// ---------------------------------------------------------------------------
// Mock: brainstorm-quality (added by another agent — mock to avoid import errors)
// ---------------------------------------------------------------------------

vi.mock('@/lib/worker/brainstorm-quality', () => ({
  computeWaveQuality: vi.fn().mockReturnValue({
    wave: 0,
    newIdeasCount: 0,
    avgResponseLength: 0,
    repeatRatio: 0,
    passCount: 0,
    agreementRatio: 0,
  }),
  shouldTriggerReflection: vi.fn().mockReturnValue(false),
  REFLECTION_PROMPT: 'Reflect on the discussion.',
}));

// ---------------------------------------------------------------------------
// Mock: worker-http
// ---------------------------------------------------------------------------

const mockLiveBrainstormHandlers = new Map<string, (payload: string) => void>();
const mockLiveBrainstormFeedbackHandlers = new Map<
  string,
  (wave: number, agentId: string, signal: string) => void
>();

vi.mock('@/lib/worker/worker-http', () => ({
  liveBrainstormHandlers: mockLiveBrainstormHandlers,
  liveBrainstormFeedbackHandlers: mockLiveBrainstormFeedbackHandlers,
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

const { BrainstormOrchestrator } = await import('../brainstorm-orchestrator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OrchestratorInternals = {
  receiveFeedback: (
    wave: number,
    agentId: string,
    signal: 'thumbs_up' | 'thumbs_down' | 'focus',
  ) => void;
  waitForFeedback: (timeoutMs: number, participantCount: number) => Promise<void>;
  formatFeedbackNote: (wave: number) => string | null;
  feedbackMap: Map<number, Array<{ agentId: string; signal: string; receivedAt: Date }>>;
  participants: Array<{ agentId: string; agentName: string; hasPassed: boolean; hasLeft: boolean }>;
  reviewPauseSec: number;
  /** Exposed for testing: set before calling waitForFeedback to simulate the orchestrator flow */
  reviewingWave: number | null;
};

function makeOrchestrator(config?: Record<string, unknown>): OrchestratorInternals {
  return new BrainstormOrchestrator('room-test', 5, 60, config) as unknown as OrchestratorInternals;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  sessionListeners.clear();
  mockBrainstormEventListeners.clear();
  mockLiveBrainstormHandlers.clear();
  mockLiveBrainstormFeedbackHandlers.clear();
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
// receiveFeedback() stores feedback correctly
// ---------------------------------------------------------------------------

describe('receiveFeedback', () => {
  it('stores feedback in feedbackMap keyed by wave number', () => {
    const orchestrator = makeOrchestrator();

    orchestrator.receiveFeedback(1, 'agent-1', 'thumbs_up');
    orchestrator.receiveFeedback(1, 'agent-2', 'thumbs_down');

    const waveOne = orchestrator.feedbackMap.get(1);
    expect(waveOne).toBeDefined();
    expect(waveOne).toHaveLength(2);
    expect(waveOne![0].agentId).toBe('agent-1');
    expect(waveOne![0].signal).toBe('thumbs_up');
    expect(waveOne![1].agentId).toBe('agent-2');
    expect(waveOne![1].signal).toBe('thumbs_down');
  });

  it('stores feedback for different waves independently', () => {
    const orchestrator = makeOrchestrator();

    orchestrator.receiveFeedback(1, 'agent-1', 'thumbs_up');
    orchestrator.receiveFeedback(2, 'agent-1', 'focus');

    expect(orchestrator.feedbackMap.get(1)).toHaveLength(1);
    expect(orchestrator.feedbackMap.get(2)).toHaveLength(1);
    expect(orchestrator.feedbackMap.get(2)![0].signal).toBe('focus');
  });

  it('records receivedAt timestamp', () => {
    const orchestrator = makeOrchestrator();
    const before = new Date();
    orchestrator.receiveFeedback(1, 'agent-1', 'thumbs_up');
    const after = new Date();

    const entry = orchestrator.feedbackMap.get(1)![0];
    expect(entry.receivedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(entry.receivedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('appends multiple feedbacks from the same wave', () => {
    const orchestrator = makeOrchestrator();
    orchestrator.receiveFeedback(3, 'agent-1', 'thumbs_up');
    orchestrator.receiveFeedback(3, 'agent-2', 'focus');
    orchestrator.receiveFeedback(3, 'agent-3', 'thumbs_down');

    const wave3 = orchestrator.feedbackMap.get(3);
    expect(wave3).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// waitForFeedback() resolves after timeout
// ---------------------------------------------------------------------------

describe('waitForFeedback — timeout', () => {
  it('resolves after the specified timeout even with no feedback', async () => {
    vi.useFakeTimers();
    const orchestrator = makeOrchestrator();

    const waitPromise = orchestrator.waitForFeedback(1000, 3);

    vi.advanceTimersByTime(1000);

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('resolves immediately when timeoutMs is 0', async () => {
    const orchestrator = makeOrchestrator();
    await expect(orchestrator.waitForFeedback(0, 3)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// waitForFeedback() resolves early when all participants respond
// ---------------------------------------------------------------------------

describe('waitForFeedback — early resolution', () => {
  it('resolves early when all active participants submit feedback', async () => {
    vi.useFakeTimers();
    const orchestrator = makeOrchestrator();

    // Set up 2 active participants
    orchestrator.participants.push(
      { agentId: 'agent-1', agentName: 'Alpha', hasPassed: false, hasLeft: false } as never,
      { agentId: 'agent-2', agentName: 'Beta', hasPassed: false, hasLeft: false } as never,
    );

    // Set the reviewing wave BEFORE starting to wait (mirrors actual orchestrator flow)
    orchestrator.reviewingWave = 1;
    const waitPromise = orchestrator.waitForFeedback(10000, 2);

    // Simulate both participants submitting feedback before the timeout
    orchestrator.receiveFeedback(1, 'agent-1', 'thumbs_up');
    orchestrator.receiveFeedback(1, 'agent-2', 'thumbs_down');

    // Advance time a tiny bit to allow microtasks to flush
    await Promise.resolve();
    vi.advanceTimersByTime(100);

    await expect(waitPromise).resolves.toBeUndefined();
  });

  it('does NOT resolve early when only some participants respond', async () => {
    vi.useFakeTimers();
    const orchestrator = makeOrchestrator();

    orchestrator.participants.push(
      { agentId: 'agent-1', agentName: 'Alpha', hasPassed: false, hasLeft: false } as never,
      { agentId: 'agent-2', agentName: 'Beta', hasPassed: false, hasLeft: false } as never,
      { agentId: 'agent-3', agentName: 'Gamma', hasPassed: false, hasLeft: false } as never,
    );

    let resolved = false;
    orchestrator.waitForFeedback(5000, 3).then(() => {
      resolved = true;
    });

    // Only one participant submits
    orchestrator.receiveFeedback(1, 'agent-1', 'thumbs_up');

    await Promise.resolve();
    vi.advanceTimersByTime(100);

    expect(resolved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Feedback formatting in wave broadcast
// ---------------------------------------------------------------------------

describe('formatFeedbackNote', () => {
  it('returns null when no feedback exists for the wave', () => {
    const orchestrator = makeOrchestrator();
    orchestrator.participants.push({
      agentId: 'agent-1',
      agentName: 'Alpha',
      hasPassed: false,
      hasLeft: false,
    } as never);

    const note = orchestrator.formatFeedbackNote(1);
    expect(note).toBeNull();
  });

  it('formats thumbs_up as on track', () => {
    const orchestrator = makeOrchestrator();
    orchestrator.participants.push({
      agentId: 'agent-1',
      agentName: 'Alpha',
      hasPassed: false,
      hasLeft: false,
    } as never);

    orchestrator.receiveFeedback(1, 'agent-1', 'thumbs_up');
    const note = orchestrator.formatFeedbackNote(1);

    expect(note).toContain('Alpha');
    expect(note).toContain('👍');
    expect(note).toContain('on track');
  });

  it('formats thumbs_down as off topic', () => {
    const orchestrator = makeOrchestrator();
    orchestrator.participants.push({
      agentId: 'agent-1',
      agentName: 'Alpha',
      hasPassed: false,
      hasLeft: false,
    } as never);

    orchestrator.receiveFeedback(1, 'agent-1', 'thumbs_down');
    const note = orchestrator.formatFeedbackNote(1);

    expect(note).toContain('Alpha');
    expect(note).toContain('👎');
    expect(note).toContain('off topic');
  });

  it('formats focus signal', () => {
    const orchestrator = makeOrchestrator();
    orchestrator.participants.push({
      agentId: 'agent-1',
      agentName: 'Alpha',
      hasPassed: false,
      hasLeft: false,
    } as never);

    orchestrator.receiveFeedback(1, 'agent-1', 'focus');
    const note = orchestrator.formatFeedbackNote(1);

    expect(note).toContain('Alpha');
    expect(note).toContain('🎯');
    expect(note).toContain('dig deeper');
  });

  it('includes moderator feedback header', () => {
    const orchestrator = makeOrchestrator();
    orchestrator.participants.push({
      agentId: 'agent-1',
      agentName: 'Alpha',
      hasPassed: false,
      hasLeft: false,
    } as never);

    orchestrator.receiveFeedback(2, 'agent-1', 'thumbs_up');
    const note = orchestrator.formatFeedbackNote(2);

    expect(note).toContain('Moderator Feedback');
    expect(note).toContain('Wave 2');
  });

  it('includes all participants when multiple submit feedback', () => {
    const orchestrator = makeOrchestrator();
    orchestrator.participants.push(
      { agentId: 'agent-1', agentName: 'Alpha', hasPassed: false, hasLeft: false } as never,
      { agentId: 'agent-2', agentName: 'Beta', hasPassed: false, hasLeft: false } as never,
    );

    orchestrator.receiveFeedback(1, 'agent-1', 'thumbs_up');
    orchestrator.receiveFeedback(1, 'agent-2', 'focus');
    const note = orchestrator.formatFeedbackNote(1);

    expect(note).toContain('Alpha');
    expect(note).toContain('Beta');
  });
});

// ---------------------------------------------------------------------------
// reviewPauseSec=0 skips the wait entirely
// ---------------------------------------------------------------------------

describe('reviewPauseSec config', () => {
  it('reviewPauseSec defaults to 0 (no pause)', () => {
    const orchestrator = makeOrchestrator();
    expect(orchestrator.reviewPauseSec).toBe(0);
  });

  it('reviewPauseSec is read from config', () => {
    const orchestrator = makeOrchestrator({ reviewPauseSec: 30 });
    expect(orchestrator.reviewPauseSec).toBe(30);
  });
});
