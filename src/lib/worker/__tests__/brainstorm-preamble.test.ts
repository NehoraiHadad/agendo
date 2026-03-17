/**
 * Tests for BrainstormOrchestrator.buildPreamble — cross-brainstorm memory (context linking)
 *
 * Verifies that when relatedRoomIds are present in room.config, buildPreamble()
 * fetches syntheses from those rooms and injects them into the preamble.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const sessionListeners = new Map<string, Array<(event: unknown) => void>>();

vi.mock('@/lib/worker/worker-sse', () => ({
  addSessionEventListener: vi.fn((sessionId: string, cb: (event: unknown) => void) => {
    if (!sessionListeners.has(sessionId)) sessionListeners.set(sessionId, []);
    sessionListeners.get(sessionId)!.push(cb);
    return () => {};
  }),
  brainstormEventListeners: new Map(),
  sessionEventListeners: new Map(),
  addBrainstormEventListener: vi.fn(),
}));

vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionControl: vi.fn().mockResolvedValue({ ok: true, dispatched: true }),
}));

const mockGetBrainstorm = vi.fn();
const mockGetCompletedRoomsForProject = vi.fn();

vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
  updateBrainstormStatus: vi.fn().mockResolvedValue(undefined),
  updateBrainstormWave: vi.fn().mockResolvedValue(undefined),
  updateParticipantSession: vi.fn().mockResolvedValue(undefined),
  updateParticipantStatus: vi.fn().mockResolvedValue(undefined),
  setBrainstormSynthesis: vi.fn().mockResolvedValue(undefined),
  updateBrainstormLogPath: vi.fn().mockResolvedValue(undefined),
  getCompletedRoomsForProject: mockGetCompletedRoomsForProject,
}));

vi.mock('@/lib/services/session-service', () => ({
  createSession: vi.fn(),
  getSessionStatus: vi.fn(),
}));

vi.mock('@/lib/worker/queue', () => ({
  enqueueSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/worker/session-runner', () => ({
  getSessionProc: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/worker/worker-http', () => ({
  liveBrainstormHandlers: new Map(),
}));

vi.mock('@/lib/worker/log-writer', () => ({
  FileLogWriter: class {
    writeEvent() {}
    async close() {}
  },
  resolveBrainstormLogPath: vi.fn().mockReturnValue('/tmp/test.log'),
}));

vi.mock('@/lib/realtime/event-utils', () => ({
  readBrainstormEventsFromLog: vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/worker/synthesis-decision-log', () => ({
  STRUCTURED_SYNTHESIS_PROMPT_SUFFIX: '',
  createTasksFromSynthesis: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { BrainstormOrchestrator } = await import('../brainstorm-orchestrator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoom(overrides: Record<string, unknown> = {}) {
  return {
    id: 'room-1',
    projectId: 'project-abc',
    taskId: null,
    title: 'Test Room',
    topic: 'Test topic',
    status: 'active',
    currentWave: 0,
    maxWaves: 5,
    config: {},
    synthesis: null,
    logFilePath: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    participants: [
      {
        id: 'p1',
        roomId: 'room-1',
        agentId: 'agent-1',
        agentName: 'Claude',
        agentSlug: 'claude-code-1',
        sessionId: null,
        model: null,
        status: 'joined',
        joinedAt: new Date(),
      },
      {
        id: 'p2',
        roomId: 'room-1',
        agentId: 'agent-2',
        agentName: 'Gemini',
        agentSlug: 'gemini-cli-1',
        sessionId: null,
        model: null,
        status: 'joined',
        joinedAt: new Date(),
      },
    ],
    project: { id: 'project-abc', name: 'Test Project' },
    task: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  sessionListeners.clear();
});

describe('buildPreamble — cross-brainstorm memory', () => {
  it('includes context from related brainstorms when relatedRoomIds are in config', async () => {
    const config = {
      relatedRoomIds: ['related-room-1', 'related-room-2'],
    };

    const room = makeRoom({ config });

    // Mock the related rooms data
    mockGetCompletedRoomsForProject.mockResolvedValue([
      {
        id: 'related-room-1',
        title: 'Architecture Discussion',
        synthesis: 'We decided to use microservices with event-driven communication.',
        createdAt: new Date('2026-03-10'),
      },
      {
        id: 'related-room-2',
        title: 'API Design',
        synthesis: 'REST API with versioned endpoints was chosen.',
        createdAt: new Date('2026-03-12'),
      },
    ]);

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);

    // Access the private method via type assertion
    const preamble = await (
      orchestrator as unknown as {
        buildPreamble: (
          room: unknown,
          otherNames: string[],
          relatedSyntheses?: Array<{ title: string; synthesis: string; createdAt: Date }>,
        ) => string;
      }
    ).buildPreamble(
      room,
      ['Gemini'],
      [
        {
          title: 'Architecture Discussion',
          synthesis: 'We decided to use microservices with event-driven communication.',
          createdAt: new Date('2026-03-10'),
        },
        {
          title: 'API Design',
          synthesis: 'REST API with versioned endpoints was chosen.',
          createdAt: new Date('2026-03-12'),
        },
      ],
    );

    expect(preamble).toContain('Context from Previous Discussions');
    expect(preamble).toContain('Architecture Discussion');
    expect(preamble).toContain('We decided to use microservices');
    expect(preamble).toContain('API Design');
    expect(preamble).toContain('REST API with versioned endpoints');
  });

  it('does not include context section when no related rooms', async () => {
    const room = makeRoom();

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);

    const preamble = (
      orchestrator as unknown as {
        buildPreamble: (
          room: unknown,
          otherNames: string[],
          relatedSyntheses?: Array<{ title: string; synthesis: string; createdAt: Date }>,
        ) => string;
      }
    ).buildPreamble(room, ['Gemini']);

    expect(preamble).not.toContain('Context from Previous Discussions');
  });

  it('truncates long syntheses to ~500 words', async () => {
    const longSynthesis = Array(600).fill('word').join(' ');
    const config = { relatedRoomIds: ['related-room-1'] };
    const room = makeRoom({ config });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);

    const preamble = (
      orchestrator as unknown as {
        buildPreamble: (
          room: unknown,
          otherNames: string[],
          relatedSyntheses?: Array<{ title: string; synthesis: string; createdAt: Date }>,
        ) => string;
      }
    ).buildPreamble(
      room,
      ['Gemini'],
      [
        {
          title: 'Long Discussion',
          synthesis: longSynthesis,
          createdAt: new Date('2026-03-10'),
        },
      ],
    );

    // Should contain truncation indicator
    expect(preamble).toContain('...');
    // The synthesis text in the preamble should be truncated — extract just
    // the synthesis portion (between the room title line and the next section)
    const contextSection = preamble.split('Long Discussion')[1]?.split('##')[0] ?? '';
    const wordCount = contextSection.split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThanOrEqual(510); // ~500 words + small margin for title/date line
  });

  it('limits to max 3 related brainstorms', async () => {
    const config = {
      relatedRoomIds: ['r1', 'r2', 'r3', 'r4'],
    };
    const room = makeRoom({ config });

    const fourSyntheses = [
      { title: 'Room 1', synthesis: 'Synthesis 1', createdAt: new Date('2026-03-10') },
      { title: 'Room 2', synthesis: 'Synthesis 2', createdAt: new Date('2026-03-11') },
      { title: 'Room 3', synthesis: 'Synthesis 3', createdAt: new Date('2026-03-12') },
      { title: 'Room 4', synthesis: 'Synthesis 4', createdAt: new Date('2026-03-13') },
    ];

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);

    const preamble = (
      orchestrator as unknown as {
        buildPreamble: (
          room: unknown,
          otherNames: string[],
          relatedSyntheses?: Array<{ title: string; synthesis: string; createdAt: Date }>,
        ) => string;
      }
    ).buildPreamble(room, ['Gemini'], fourSyntheses);

    // Should contain only 3, not 4
    expect(preamble).toContain('Room 1');
    expect(preamble).toContain('Room 2');
    expect(preamble).toContain('Room 3');
    expect(preamble).not.toContain('Room 4');
  });
});
