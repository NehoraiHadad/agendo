/**
 * Tests for BrainstormOrchestrator.buildPreamble
 *
 * Covers:
 * - Cross-brainstorm memory (context linking via relatedRoomIds)
 * - Per-participant role instructions (critic, optimist, pragmatist, architect)
 * - Auto-assignment of roles when none are explicitly configured
 * - Backward compatibility: agents without a role get a generic preamble
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
  buildSynthesisPrompt: vi.fn().mockReturnValue(''),
  createTasksFromSynthesis: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { BrainstormOrchestrator } = await import('../brainstorm-orchestrator');

// ---------------------------------------------------------------------------
// Type alias for the private buildPreamble method
// ---------------------------------------------------------------------------

type BuildPreambleFn = (
  room: unknown,
  otherNames: string[],
  currentParticipantSlug: string,
  relatedSyntheses?: Array<{ title: string; synthesis: string; createdAt: Date }>,
) => string;

function getPreambleBuilder(orchestrator: InstanceType<typeof BrainstormOrchestrator>) {
  return (orchestrator as unknown as { buildPreamble: BuildPreambleFn }).buildPreamble.bind(
    orchestrator,
  );
}

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
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1', [
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
    ]);

    expect(preamble).toContain('Context from Previous Discussions');
    expect(preamble).toContain('Architecture Discussion');
    expect(preamble).toContain('We decided to use microservices');
    expect(preamble).toContain('API Design');
    expect(preamble).toContain('REST API with versioned endpoints');
  });

  it('does not include context section when no related rooms', async () => {
    const room = makeRoom();

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).not.toContain('Context from Previous Discussions');
  });

  it('truncates long syntheses to ~500 words', async () => {
    const longSynthesis = Array(600).fill('word').join(' ');
    const config = { relatedRoomIds: ['related-room-1'] };
    const room = makeRoom({ config });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1', [
      {
        title: 'Long Discussion',
        synthesis: longSynthesis,
        createdAt: new Date('2026-03-10'),
      },
    ]);

    // Should contain truncation indicator
    expect(preamble).toContain('...');
    // The synthesis text in the preamble should be truncated — extract just
    // the synthesis portion (between the room title line and the next section)
    const contextSection = preamble.split('Long Discussion')[1]?.split('##')[0] ?? '';
    const wordCount = contextSection.split(/\s+/).filter(Boolean).length;
    expect(wordCount).toBeLessThanOrEqual(510); // ~500 words + small margin for title/date line
  });

  it('does NOT include the room topic in the preamble text', () => {
    const room = makeRoom({ topic: 'How should we restructure the worker queue?' });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).not.toContain('How should we restructure the worker queue?');
  });

  it('ends the preamble with an instruction to wait for the topic wave message', () => {
    const room = makeRoom({ topic: 'Some topic that must not appear' });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    // Preamble should tell the agent to wait for the topic
    expect(preamble.toLowerCase()).toMatch(/wait|first wave message/);
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
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1', fourSyntheses);

    // Should contain only 3, not 4
    expect(preamble).toContain('Room 1');
    expect(preamble).toContain('Room 2');
    expect(preamble).toContain('Room 3');
    expect(preamble).not.toContain('Room 4');
  });
});

describe('buildPreamble — role instructions', () => {
  it('injects critic role instructions for the agent assigned the critic role', () => {
    const config = {
      roles: { critic: 'claude-code-1', pragmatist: 'gemini-cli-1' },
    };
    const room = makeRoom({ config });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).toContain('Your Role');
    expect(preamble).toContain('CRITIC');
  });

  it('injects pragmatist role instructions for the agent assigned the pragmatist role', () => {
    const config = {
      roles: { critic: 'claude-code-1', pragmatist: 'gemini-cli-1' },
    };
    const room = makeRoom({ config });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Claude'], 'gemini-cli-1');

    expect(preamble).toContain('Your Role');
    expect(preamble).toContain('PRAGMATIST');
  });

  it('does not inject role instructions for an agent with no assigned role', () => {
    // No roles configured — backward compatible generic preamble
    const room = makeRoom();

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).not.toContain('Your Role');
    expect(preamble).not.toContain('CRITIC');
    expect(preamble).not.toContain('PRAGMATIST');
  });

  it('does not inject role section when roles are configured but current agent has no role', () => {
    // Only gemini is assigned a role; claude gets none
    const config = {
      roles: { critic: 'gemini-cli-1' },
    };
    const room = makeRoom({ config });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    // Assigned Roles section is present (global list), but no "Your Role" block
    expect(preamble).toContain('Assigned Roles');
    expect(preamble).not.toContain('Your Role');
  });

  it('uses custom roleInstructions from config when provided', () => {
    const config = {
      roles: { critic: 'claude-code-1' },
      roleInstructions: {
        critic: 'You are the custom critic — challenge everything aggressively.',
      },
    };
    const room = makeRoom({ config });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).toContain('Your Role');
    expect(preamble).toContain('custom critic — challenge everything aggressively');
    // Default instructions must NOT appear
    expect(preamble).not.toContain('Challenge assumptions others make');
  });

  it('falls back to default instructions when roleInstructions does not cover the role', () => {
    const config = {
      roles: { optimist: 'claude-code-1' },
      // roleInstructions only covers critic, not optimist
      roleInstructions: { critic: 'Custom critic text' },
    };
    const room = makeRoom({ config });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).toContain('Your Role');
    expect(preamble).toContain('OPTIMIST');
  });

  it('falls back to generic role label when role is unknown and no custom instructions', () => {
    const config = {
      roles: { 'devil-advocate': 'claude-code-1' },
    };
    const room = makeRoom({ config });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, config);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).toContain('Your Role');
    expect(preamble).toContain('devil-advocate');
  });
});

describe('buildPreamble — provider personas', () => {
  it('injects a provider lens even when no explicit role is assigned', () => {
    const room = makeRoom();

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).toContain('Your Provider Lens');
    expect(preamble).toContain('Claude');
    expect(preamble).toContain('architectural consistency');
  });

  it('composes the role block with a role-specific Codex provider lens', () => {
    const room = makeRoom({
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
          agentName: 'Codex',
          agentSlug: 'codex-cli-1',
          sessionId: null,
          model: null,
          status: 'joined',
          joinedAt: new Date(),
        },
      ],
      config: {
        roles: { critic: 'claude-code-1', pragmatist: 'codex-cli-1' },
      },
    });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, {
      roles: { critic: 'claude-code-1', pragmatist: 'codex-cli-1' },
    });
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Claude'], 'codex-cli-1');

    expect(preamble).toContain('Your Role');
    expect(preamble).toContain('PRAGMATIST');
    expect(preamble).toContain('Your Provider Lens');
    expect(preamble).toContain('Codex');
    expect(preamble).toContain('As Codex in the pragmatist seat');
  });

  it('infers the Gemini provider lens from the participant slug', () => {
    const room = makeRoom({
      participants: [
        {
          id: 'p1',
          roomId: 'room-1',
          agentId: 'agent-1',
          agentName: 'Gemini',
          agentSlug: 'gemini-cli-1',
          sessionId: null,
          model: null,
          status: 'joined',
          joinedAt: new Date(),
        },
        {
          id: 'p2',
          roomId: 'room-1',
          agentId: 'agent-2',
          agentName: 'Claude',
          agentSlug: 'claude-code-1',
          sessionId: null,
          model: null,
          status: 'joined',
          joinedAt: new Date(),
        },
      ],
      config: {
        roles: { optimist: 'gemini-cli-1', critic: 'claude-code-1' },
      },
    });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120, {
      roles: { optimist: 'gemini-cli-1', critic: 'claude-code-1' },
    });
    const buildPreamble = getPreambleBuilder(orchestrator);

    const preamble = buildPreamble(room, ['Claude'], 'gemini-cli-1');

    expect(preamble).toContain('Your Provider Lens');
    expect(preamble).toContain('Gemini');
    expect(preamble).toContain('As Gemini in the optimist seat');
  });
});

describe('buildPreamble — auto-assignment', () => {
  it('assigns critic role to first participant when 2 agents have no explicit roles', () => {
    const room = makeRoom(); // 2 participants: claude-code-1 (p1), gemini-cli-1 (p2)

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);

    // Simulate auto-assignment that createParticipantSessions would do
    (orchestrator as unknown as { playbook: { roles?: Record<string, string> } }).playbook.roles = {
      critic: 'claude-code-1',
      pragmatist: 'gemini-cli-1',
    };

    const buildPreamble = getPreambleBuilder(orchestrator);
    const preamble = buildPreamble(room, ['Gemini'], 'claude-code-1');

    expect(preamble).toContain('CRITIC');
  });

  it('assigns pragmatist role to second participant when 2 agents have no explicit roles', () => {
    const room = makeRoom(); // 2 participants: claude-code-1 (p1), gemini-cli-1 (p2)

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);

    // Simulate auto-assignment
    (orchestrator as unknown as { playbook: { roles?: Record<string, string> } }).playbook.roles = {
      critic: 'claude-code-1',
      pragmatist: 'gemini-cli-1',
    };

    const buildPreamble = getPreambleBuilder(orchestrator);
    const preamble = buildPreamble(room, ['Claude'], 'gemini-cli-1');

    expect(preamble).toContain('PRAGMATIST');
  });

  it('assigns 3 roles for 3 participants (critic, optimist, pragmatist)', () => {
    const threeParticipantRoom = makeRoom({
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
        {
          id: 'p3',
          roomId: 'room-1',
          agentId: 'agent-3',
          agentName: 'Codex',
          agentSlug: 'codex-cli-1',
          sessionId: null,
          model: null,
          status: 'joined',
          joinedAt: new Date(),
        },
      ],
    });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);

    // Simulate auto-assignment for 3 agents
    (orchestrator as unknown as { playbook: { roles?: Record<string, string> } }).playbook.roles = {
      critic: 'claude-code-1',
      optimist: 'gemini-cli-1',
      pragmatist: 'codex-cli-1',
    };

    const buildPreamble = getPreambleBuilder(orchestrator);

    // Each participant gets their role
    const claudePreamble = buildPreamble(
      threeParticipantRoom,
      ['Gemini', 'Codex'],
      'claude-code-1',
    );
    expect(claudePreamble).toContain('CRITIC');

    const geminiPreamble = buildPreamble(threeParticipantRoom, ['Claude', 'Codex'], 'gemini-cli-1');
    expect(geminiPreamble).toContain('OPTIMIST');

    const codexPreamble = buildPreamble(threeParticipantRoom, ['Claude', 'Gemini'], 'codex-cli-1');
    expect(codexPreamble).toContain('PRAGMATIST');
  });

  it('assigns 4 roles for 4 participants including architect', () => {
    const fourParticipantRoom = makeRoom({
      participants: [
        {
          id: 'p1',
          roomId: 'room-1',
          agentId: 'a1',
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
          agentId: 'a2',
          agentName: 'Gemini',
          agentSlug: 'gemini-cli-1',
          sessionId: null,
          model: null,
          status: 'joined',
          joinedAt: new Date(),
        },
        {
          id: 'p3',
          roomId: 'room-1',
          agentId: 'a3',
          agentName: 'Codex',
          agentSlug: 'codex-cli-1',
          sessionId: null,
          model: null,
          status: 'joined',
          joinedAt: new Date(),
        },
        {
          id: 'p4',
          roomId: 'room-1',
          agentId: 'a4',
          agentName: 'Copilot',
          agentSlug: 'github-copilot-cli',
          sessionId: null,
          model: null,
          status: 'joined',
          joinedAt: new Date(),
        },
      ],
    });

    const orchestrator = new BrainstormOrchestrator('room-1', 5, 120);

    // Simulate auto-assignment for 4 agents
    (orchestrator as unknown as { playbook: { roles?: Record<string, string> } }).playbook.roles = {
      critic: 'claude-code-1',
      optimist: 'gemini-cli-1',
      pragmatist: 'codex-cli-1',
      architect: 'github-copilot-cli',
    };

    const buildPreamble = getPreambleBuilder(orchestrator);

    const copilotPreamble = buildPreamble(
      fourParticipantRoom,
      ['Claude', 'Gemini', 'Codex'],
      'github-copilot-cli',
    );
    expect(copilotPreamble).toContain('ARCHITECT');
  });
});
