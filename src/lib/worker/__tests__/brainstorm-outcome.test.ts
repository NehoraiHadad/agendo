/**
 * Tests for brainstorm outcome instrumentation
 *
 * Tests cover:
 * - computeBrainstormOutcome() for various end states
 * - Correct counting of timeouts, evictions, participants
 * - Convergence wave tracking
 * - Reflection wave counting
 * - Duration calculation
 * - Synthesis parse success detection
 */

import { describe, it, expect } from 'vitest';
import { computeBrainstormOutcome } from '@/lib/worker/brainstorm-outcome';
import type { BrainstormOutcome } from '@/lib/db/schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParticipant(overrides: {
  hasPassed?: boolean;
  hasLeft?: boolean;
  consecutiveTimeouts?: number;
}) {
  return {
    participantId: 'p-1',
    agentId: 'a-1',
    agentName: 'Agent',
    hasPassed: overrides.hasPassed ?? false,
    hasLeft: overrides.hasLeft ?? false,
    consecutiveTimeouts: overrides.consecutiveTimeouts ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeBrainstormOutcome', () => {
  const baseInput = {
    endState: 'converged' as BrainstormOutcome['endState'],
    totalWaves: 3,
    participants: [makeParticipant({}), makeParticipant({})],
    startTimeMs: 1000,
    endTimeMs: 61000,
    convergenceWave: 3,
    reflectionWavesTriggered: 0,
    synthesisParseSuccess: true,
    taskCreationCount: 2,
    deliverableType: 'action_plan' as string | null,
    totalTimeoutCount: 0,
  };

  it('computes a correct outcome for a converged room', () => {
    const outcome = computeBrainstormOutcome(baseInput);

    expect(outcome).toEqual<BrainstormOutcome>({
      endState: 'converged',
      totalWaves: 3,
      totalParticipants: 2,
      activeParticipantsAtEnd: 2,
      evictedCount: 0,
      timeoutCount: 0,
      synthesisParseSuccess: true,
      taskCreationCount: 2,
      totalDurationMs: 60000,
      convergenceWave: 3,
      reflectionWavesTriggered: 0,
      deliverableType: 'action_plan',
    });
  });

  it('sets convergenceWave to null for non-converged end states', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      endState: 'max_waves',
      convergenceWave: null,
    });

    expect(outcome.endState).toBe('max_waves');
    expect(outcome.convergenceWave).toBeNull();
  });

  it('counts evicted participants (hasLeft)', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      participants: [
        makeParticipant({}),
        makeParticipant({ hasLeft: true }),
        makeParticipant({ hasLeft: true }),
      ],
    });

    expect(outcome.totalParticipants).toBe(3);
    expect(outcome.evictedCount).toBe(2);
    expect(outcome.activeParticipantsAtEnd).toBe(1);
  });

  it('counts total timeouts from the provided count', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      totalTimeoutCount: 5,
    });

    expect(outcome.timeoutCount).toBe(5);
  });

  it('records stalled end state', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      endState: 'stalled',
      convergenceWave: null,
      totalTimeoutCount: 4,
    });

    expect(outcome.endState).toBe('stalled');
    expect(outcome.timeoutCount).toBe(4);
    expect(outcome.convergenceWave).toBeNull();
  });

  it('records error end state', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      endState: 'error',
      convergenceWave: null,
      synthesisParseSuccess: false,
      taskCreationCount: 0,
    });

    expect(outcome.endState).toBe('error');
    expect(outcome.synthesisParseSuccess).toBe(false);
    expect(outcome.taskCreationCount).toBe(0);
  });

  it('records reflection waves triggered', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      reflectionWavesTriggered: 3,
    });

    expect(outcome.reflectionWavesTriggered).toBe(3);
  });

  it('records manual_end state', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      endState: 'manual_end',
      convergenceWave: null,
    });

    expect(outcome.endState).toBe('manual_end');
  });

  it('records null deliverableType when not configured', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      deliverableType: null,
    });

    expect(outcome.deliverableType).toBeNull();
  });

  it('handles room with all participants passed (active at end)', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      participants: [makeParticipant({ hasPassed: true }), makeParticipant({ hasPassed: true })],
    });

    // Passed participants are still active (not evicted)
    expect(outcome.activeParticipantsAtEnd).toBe(2);
    expect(outcome.evictedCount).toBe(0);
  });

  it('handles zero-duration room', () => {
    const outcome = computeBrainstormOutcome({
      ...baseInput,
      startTimeMs: 5000,
      endTimeMs: 5000,
    });

    expect(outcome.totalDurationMs).toBe(0);
  });
});
