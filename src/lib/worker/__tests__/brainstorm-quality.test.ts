/**
 * Tests for wave quality scoring and stall detection (TDD Red phase)
 *
 * Covers:
 * - computeWaveQuality() with sample responses
 * - shouldTriggerReflection() triggers after 2 consecutive declining waves
 * - shouldTriggerReflection() returns false after only 1 declining wave
 * - shouldTriggerReflection() respects reflectionInterval (no double-trigger too soon)
 * - autoReflection=false disables reflection entirely
 */

import { describe, it, expect } from 'vitest';
import { computeWaveQuality, shouldTriggerReflection } from '@/lib/worker/brainstorm-quality';
import type { WaveQualityScore } from '@/lib/worker/brainstorm-quality';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScore(overrides: Partial<WaveQualityScore>): WaveQualityScore {
  return {
    wave: 1,
    newIdeasCount: 3,
    avgResponseLength: 80,
    repeatRatio: 0.2,
    passCount: 0,
    agreementRatio: 0.1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeWaveQuality
// ---------------------------------------------------------------------------

describe('computeWaveQuality', () => {
  it('returns wave number in output', () => {
    const responses = [{ agentName: 'A', content: 'hello world foo bar', isPass: false }];
    const score = computeWaveQuality(2, responses, []);
    expect(score.wave).toBe(2);
  });

  it('counts pass responses correctly', () => {
    const responses = [
      { agentName: 'A', content: 'I agree — PASS', isPass: true },
      { agentName: 'B', content: 'Good point, but let me add something new here.', isPass: false },
    ];
    const score = computeWaveQuality(1, responses, []);
    expect(score.passCount).toBe(1);
  });

  it('computes avgResponseLength excluding PASS responses', () => {
    const responses = [
      { agentName: 'A', content: 'one two three four five', isPass: false }, // 5 words
      { agentName: 'B', content: 'PASS', isPass: true }, // excluded
      { agentName: 'C', content: 'alpha beta gamma delta epsilon zeta', isPass: false }, // 6 words
    ];
    const score = computeWaveQuality(1, responses, []);
    // avg = (5 + 6) / 2 = 5.5
    expect(score.avgResponseLength).toBeCloseTo(5.5, 1);
  });

  it('returns avgResponseLength=0 when all responses are PASS', () => {
    const responses = [
      { agentName: 'A', content: 'PASS', isPass: true },
      { agentName: 'B', content: 'PASS', isPass: true },
    ];
    const score = computeWaveQuality(1, responses, []);
    expect(score.avgResponseLength).toBe(0);
  });

  it('computes repeatRatio=0 when there are no previous wave texts', () => {
    const responses = [
      {
        agentName: 'A',
        content: 'brand new idea about caching architecture distributed',
        isPass: false,
      },
    ];
    const score = computeWaveQuality(1, responses, []);
    expect(score.repeatRatio).toBe(0);
  });

  it('computes repeatRatio > 0 when content overlaps with previous waves', () => {
    const prev = ['we should use distributed caching with redis for performance'];
    const responses = [
      {
        agentName: 'A',
        content: 'we should use distributed caching with redis for performance and scale',
        isPass: false,
      },
    ];
    const score = computeWaveQuality(2, responses, prev);
    expect(score.repeatRatio).toBeGreaterThan(0);
  });

  it('computes repeatRatio close to 1 when content is almost identical to previous wave', () => {
    const text = 'the quick brown fox jumps over the lazy dog and then runs away fast';
    const prev = [text];
    const responses = [{ agentName: 'A', content: text, isPass: false }];
    const score = computeWaveQuality(2, responses, prev);
    expect(score.repeatRatio).toBeGreaterThan(0.8);
  });

  it('detects agreement markers correctly', () => {
    const responses = [
      { agentName: 'A', content: 'I agree with that point completely', isPass: false },
      { agentName: 'B', content: 'Good point, and I would add caching', isPass: false },
      { agentName: 'C', content: '+1 to the previous suggestion', isPass: false },
      { agentName: 'D', content: 'I think we should reconsider the architecture', isPass: false },
    ];
    const score = computeWaveQuality(3, responses, []);
    // A, B, C agree (3 out of 4)
    expect(score.agreementRatio).toBeCloseTo(0.75, 1);
  });

  it('counts new ideas (bullet points and headings not seen before)', () => {
    const responses = [
      {
        agentName: 'A',
        content: '- Use Redis for caching\n- Add rate limiting\n## Architecture\nSome text here',
        isPass: false,
      },
    ];
    const score = computeWaveQuality(1, responses, []);
    // 2 bullet points + 1 heading = 3 new ideas
    expect(score.newIdeasCount).toBeGreaterThan(0);
  });

  it('handles empty responses array', () => {
    const score = computeWaveQuality(1, [], []);
    expect(score.wave).toBe(1);
    expect(score.passCount).toBe(0);
    expect(score.avgResponseLength).toBe(0);
    expect(score.repeatRatio).toBe(0);
    expect(score.newIdeasCount).toBe(0);
    expect(score.agreementRatio).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// shouldTriggerReflection
// ---------------------------------------------------------------------------

describe('shouldTriggerReflection', () => {
  it('returns false when autoReflection is false', () => {
    const scores: WaveQualityScore[] = [
      makeScore({ wave: 2, repeatRatio: 0.8, avgResponseLength: 100 }),
      makeScore({ wave: 3, repeatRatio: 0.85, avgResponseLength: 80 }),
    ];
    expect(shouldTriggerReflection(scores, { autoReflection: false, reflectionInterval: 3 })).toBe(
      false,
    );
  });

  it('returns false when there is only 1 declining wave', () => {
    const scores: WaveQualityScore[] = [
      makeScore({ wave: 2, repeatRatio: 0.6, avgResponseLength: 100 }),
    ];
    expect(shouldTriggerReflection(scores, { autoReflection: true, reflectionInterval: 3 })).toBe(
      false,
    );
  });

  it('returns false when repeatRatio is low even over 2 waves', () => {
    const scores: WaveQualityScore[] = [
      makeScore({ wave: 2, repeatRatio: 0.2, avgResponseLength: 100 }),
      makeScore({ wave: 3, repeatRatio: 0.3, avgResponseLength: 80 }),
    ];
    expect(shouldTriggerReflection(scores, { autoReflection: true, reflectionInterval: 3 })).toBe(
      false,
    );
  });

  it('returns false when repeatRatio is high but avgResponseLength is not declining', () => {
    const scores: WaveQualityScore[] = [
      makeScore({ wave: 2, repeatRatio: 0.6, avgResponseLength: 80 }),
      makeScore({ wave: 3, repeatRatio: 0.65, avgResponseLength: 90 }), // length increased
    ];
    expect(shouldTriggerReflection(scores, { autoReflection: true, reflectionInterval: 3 })).toBe(
      false,
    );
  });

  it('returns true when last 2 consecutive scores have repeatRatio > 0.5 AND declining length', () => {
    const scores: WaveQualityScore[] = [
      makeScore({ wave: 1, repeatRatio: 0.2, avgResponseLength: 120 }),
      makeScore({ wave: 2, repeatRatio: 0.6, avgResponseLength: 100 }),
      makeScore({ wave: 3, repeatRatio: 0.7, avgResponseLength: 80 }),
    ];
    expect(shouldTriggerReflection(scores, { autoReflection: true, reflectionInterval: 3 })).toBe(
      true,
    );
  });

  it('respects reflectionInterval: does not trigger again within N waves of last reflection', () => {
    // Last reflection was at wave 3, interval=3 — wave 4 and 5 should not trigger
    const scores: WaveQualityScore[] = [
      makeScore({ wave: 3, repeatRatio: 0.7, avgResponseLength: 80 }), // was reflection wave
      makeScore({ wave: 4, repeatRatio: 0.75, avgResponseLength: 70 }),
      makeScore({ wave: 5, repeatRatio: 0.8, avgResponseLength: 60 }),
    ];
    // lastReflectionWave=3, current wave=5, interval=3 → 5-3=2 < 3, should NOT trigger
    expect(
      shouldTriggerReflection(scores, {
        autoReflection: true,
        reflectionInterval: 3,
        lastReflectionWave: 3,
      }),
    ).toBe(false);
  });

  it('triggers again after enough waves have passed since last reflection', () => {
    // Last reflection was at wave 2, interval=3 — wave 6 should trigger
    const scores: WaveQualityScore[] = [
      makeScore({ wave: 5, repeatRatio: 0.6, avgResponseLength: 100 }),
      makeScore({ wave: 6, repeatRatio: 0.7, avgResponseLength: 80 }),
    ];
    // lastReflectionWave=2, current wave=6, interval=3 → 6-2=4 >= 3, should trigger
    expect(
      shouldTriggerReflection(scores, {
        autoReflection: true,
        reflectionInterval: 3,
        lastReflectionWave: 2,
      }),
    ).toBe(true);
  });

  it('returns false when scores array has fewer than 2 entries', () => {
    expect(shouldTriggerReflection([], { autoReflection: true, reflectionInterval: 3 })).toBe(
      false,
    );
  });
});
