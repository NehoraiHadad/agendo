/**
 * Tests for BrainstormOrchestrator Playbook integration:
 * - Constructor reads all Playbook fields from room.config
 * - buildPreamble() injects language and role assignments
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgendoEvent } from '@/lib/realtime/event-types';

// ---------------------------------------------------------------------------
// Mock: worker-sse
// ---------------------------------------------------------------------------
const sessionListeners = new Map<string, Array<(event: AgendoEvent) => void>>();

const mockAddSessionEventListener = vi.fn((sessionId: string, cb: (event: AgendoEvent) => void) => {
  if (!sessionListeners.has(sessionId)) sessionListeners.set(sessionId, []);
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

vi.mock('@/lib/realtime/worker-client', () => ({
  sendSessionControl: vi.fn().mockResolvedValue({ ok: true, dispatched: true }),
}));

// ---------------------------------------------------------------------------
// Mock: brainstorm-service
// ---------------------------------------------------------------------------
const mockGetBrainstorm = vi.fn();
vi.mock('@/lib/services/brainstorm-service', () => ({
  getBrainstorm: mockGetBrainstorm,
  updateBrainstormStatus: vi.fn().mockResolvedValue(undefined),
  updateBrainstormWave: vi.fn().mockResolvedValue(undefined),
  updateBrainstormLogPath: vi.fn().mockResolvedValue(undefined),
  updateParticipantSession: vi.fn().mockResolvedValue(undefined),
  updateParticipantStatus: vi.fn().mockResolvedValue(undefined),
  setBrainstormSynthesis: vi.fn().mockResolvedValue(undefined),
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

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------
const { BrainstormOrchestrator } = await import('@/lib/worker/brainstorm-orchestrator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Access private buildPreamble via casting */
type OrchestratorInternal = {
  buildPreamble: (
    room: {
      title: string;
      topic: string;
      config: Record<string, unknown> | null;
      participants: Array<{ agentName: string; agentSlug: string }>;
    },
    otherParticipantNames: string[],
  ) => string;
  waveTimeoutSec: number;
  wave0ExtraTimeoutSec: number;
  convergenceMode: string;
  minWavesBeforePass: number;
  requiredObjections: number;
  synthesisMode: string;
  maxWaves: number;
  participantReadyTimeoutSec: number;
  playbook: {
    language?: string;
    roles?: Record<string, string>;
    synthesisAgentId?: string;
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionListeners.clear();
  mockBrainstormEventListeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================================
// Constructor reads playbook config
// ============================================================================

describe('BrainstormOrchestrator constructor with playbook config', () => {
  it('uses defaults when no config is provided', () => {
    const orch = new BrainstormOrchestrator('room-1', 10) as unknown as OrchestratorInternal;
    expect(orch.waveTimeoutSec).toBe(120);
    expect(orch.maxWaves).toBe(10);
  });

  it('reads waveTimeoutSec from config', () => {
    const orch = new BrainstormOrchestrator('room-1', 10, 90) as unknown as OrchestratorInternal;
    expect(orch.waveTimeoutSec).toBe(90);
  });
});

// ============================================================================
// buildPreamble injects language and roles
// ============================================================================

describe('buildPreamble with playbook', () => {
  it('includes language instruction when language is set in config', () => {
    const orch = new BrainstormOrchestrator('room-lang', 10, 120, {
      language: 'Spanish',
    }) as unknown as OrchestratorInternal;

    const preamble = orch.buildPreamble(
      {
        title: 'Test Room',
        topic: 'Test Topic',
        config: { language: 'Spanish' },
        participants: [
          { agentName: 'Claude', agentSlug: 'claude-code-1' },
          { agentName: 'Gemini', agentSlug: 'gemini-cli-1' },
        ],
      },
      ['Claude', 'Gemini'],
    );

    expect(preamble).toContain('Spanish');
    expect(preamble).toMatch(/language|respond in/i);
  });

  it('includes role assignment when roles are set in config', () => {
    const orch = new BrainstormOrchestrator('room-roles', 10, 120, {
      roles: { critic: 'claude-code-1', advocate: 'gemini-cli-1' },
    }) as unknown as OrchestratorInternal;

    const preamble = orch.buildPreamble(
      {
        title: 'Test Room',
        topic: 'Test Topic',
        config: { roles: { critic: 'claude-code-1', advocate: 'gemini-cli-1' } },
        participants: [
          { agentName: 'Claude', agentSlug: 'claude-code-1' },
          { agentName: 'Gemini', agentSlug: 'gemini-cli-1' },
        ],
      },
      ['Claude', 'Gemini'],
    );

    expect(preamble).toContain('critic');
    expect(preamble).toContain('advocate');
  });

  it('omits language section when language is not set', () => {
    const orch = new BrainstormOrchestrator('room-nolang', 10, 120) as unknown as OrchestratorInternal;

    const preamble = orch.buildPreamble(
      {
        title: 'Test Room',
        topic: 'Test Topic',
        config: null,
        participants: [{ agentName: 'Claude', agentSlug: 'claude-code-1' }],
      },
      ['Claude'],
    );

    expect(preamble).not.toContain('Language');
    expect(preamble).not.toContain('Respond in');
  });

  it('omits role section when roles are not set', () => {
    const orch = new BrainstormOrchestrator('room-noroles', 10, 120) as unknown as OrchestratorInternal;

    const preamble = orch.buildPreamble(
      {
        title: 'Test Room',
        topic: 'Test Topic',
        config: null,
        participants: [{ agentName: 'Claude', agentSlug: 'claude-code-1' }],
      },
      ['Claude'],
    );

    expect(preamble).not.toContain('Your Role');
    expect(preamble).not.toContain('Assigned Role');
  });
});
