/**
 * Pure computation for brainstorm outcome instrumentation.
 *
 * Extracted from the orchestrator so it can be tested in isolation
 * without needing to mock the full brainstorm environment.
 */

import type { BrainstormOutcome } from '@/lib/db/schema';

export interface BrainstormOutcomeInput {
  endState: BrainstormOutcome['endState'];
  totalWaves: number;
  participants: Array<{
    hasPassed: boolean;
    hasLeft: boolean;
  }>;
  startTimeMs: number;
  endTimeMs: number;
  convergenceWave: number | null;
  reflectionWavesTriggered: number;
  synthesisParseSuccess: boolean;
  taskCreationCount: number;
  deliverableType: string | null;
  totalTimeoutCount: number;
}

/**
 * Compute a structured outcome record from brainstorm state at the end of a run.
 */
export function computeBrainstormOutcome(input: BrainstormOutcomeInput): BrainstormOutcome {
  const totalParticipants = input.participants.length;
  const evictedCount = input.participants.filter((p) => p.hasLeft).length;
  const activeParticipantsAtEnd = totalParticipants - evictedCount;

  return {
    endState: input.endState,
    totalWaves: input.totalWaves,
    totalParticipants,
    activeParticipantsAtEnd,
    evictedCount,
    timeoutCount: input.totalTimeoutCount,
    synthesisParseSuccess: input.synthesisParseSuccess,
    taskCreationCount: input.taskCreationCount,
    totalDurationMs: input.endTimeMs - input.startTimeMs,
    convergenceWave: input.convergenceWave,
    reflectionWavesTriggered: input.reflectionWavesTriggered,
    deliverableType: input.deliverableType,
  };
}
