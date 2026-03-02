import { describe, it, expect } from 'vitest';
import {
  getLatestContextStats,
  fmtTokens,
  fmtPct,
  ctxBarWidth,
  ctxBarColor,
} from '../context-stats';
import type { AgendoEvent } from '@/lib/realtime/events';

function makeResultEvent(
  overrides: Partial<{
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    perCallContextStats:
      | {
          inputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
        }
      | undefined;
  }> = {},
): AgendoEvent {
  const {
    inputTokens = 10,
    cacheReadInputTokens = 0,
    cacheCreationInputTokens = 0,
    contextWindow = 200000,
    perCallContextStats = undefined,
  } = overrides;

  return {
    id: 1,
    sessionId: 'sess-1',
    ts: Date.now(),
    type: 'agent:result',
    costUsd: 0.01,
    turns: 1,
    durationMs: 1000,
    modelUsage: {
      'claude-sonnet-4-6': {
        inputTokens,
        outputTokens: 500,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        costUSD: 0.01,
        contextWindow,
      },
    },
    perCallContextStats,
  } as AgendoEvent;
}

describe('getLatestContextStats', () => {
  it('returns null when no events', () => {
    expect(getLatestContextStats([])).toBeNull();
  });

  it('returns null when no agent:result events', () => {
    const events: AgendoEvent[] = [
      { id: 1, sessionId: 's', ts: 0, type: 'agent:text', text: 'hi' },
    ];
    expect(getLatestContextStats(events)).toBeNull();
  });

  // -----------------------------------------------------------------------
  // perCallContextStats path (preferred)
  // -----------------------------------------------------------------------

  it('uses perCallContextStats when present — simple turn', () => {
    const event = makeResultEvent({
      inputTokens: 7,
      cacheReadInputTokens: 122684,
      cacheCreationInputTokens: 26488,
      contextWindow: 200000,
      perCallContextStats: {
        inputTokens: 7,
        cacheReadInputTokens: 122684,
        cacheCreationInputTokens: 26488,
      },
    });

    const stats = getLatestContextStats([event]);

    expect(stats).not.toBeNull();
    // Total = 7 + 122684 + 26488 = 149179
    expect(stats?.inputTokens).toBe(149179);
    expect(stats?.contextWindow).toBe(200000);
  });

  it('perCallContextStats: 100% context usage shows 200000', () => {
    const event = makeResultEvent({
      perCallContextStats: {
        inputTokens: 10,
        cacheReadInputTokens: 173484,
        cacheCreationInputTokens: 27247,
      },
      contextWindow: 200000,
    });

    const stats = getLatestContextStats([event]);
    // 10 + 173484 + 27247 = 200741 → still reports raw (perCallContextStats is trusted)
    expect(stats?.inputTokens).toBe(200741);
  });

  // -----------------------------------------------------------------------
  // modelUsage fallback path
  // -----------------------------------------------------------------------

  it('falls back to modelUsage when perCallContextStats absent — single API call (accurate)', () => {
    // Single-turn, single API call: total ≤ contextWindow → accurate
    const event = makeResultEvent({
      inputTokens: 10,
      cacheReadInputTokens: 90000,
      cacheCreationInputTokens: 20000,
      contextWindow: 200000,
      perCallContextStats: undefined,
    });

    const stats = getLatestContextStats([event]);
    // 10 + 90000 + 20000 = 110010 — within context window
    expect(stats?.inputTokens).toBe(110010);
  });

  it('falls back to modelUsage — caps at contextWindow for multi-call aggregation', () => {
    // Simulate a complex turn where CLI aggregated 10 API calls × 150K each = 1.5M
    // Without cap: would show 1,500,000/200,000 = 750% (absurd)
    // With cap: shows 200,000/200,000 = 100% (at least honest)
    const event = makeResultEvent({
      inputTokens: 22,
      cacheReadInputTokens: 1152993, // 10× accumulated cache reads
      cacheCreationInputTokens: 44701,
      contextWindow: 200000,
      perCallContextStats: undefined,
    });

    const stats = getLatestContextStats([event]);
    expect(stats?.inputTokens).toBe(200000); // capped at contextWindow
    expect(stats?.contextWindow).toBe(200000);
  });

  it('falls back to old inputTokens-only behavior when no cache fields exist', () => {
    // Old-style response without cache fields
    const event: AgendoEvent = {
      id: 1,
      sessionId: 's',
      ts: 0,
      type: 'agent:result',
      costUsd: null,
      turns: null,
      durationMs: null,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 5000,
          outputTokens: 500,
          costUSD: 0.01,
          contextWindow: 200000,
        },
      },
    };

    const stats = getLatestContextStats([event]);
    expect(stats?.inputTokens).toBe(5000);
  });

  // -----------------------------------------------------------------------
  // Most recent event wins
  // -----------------------------------------------------------------------

  it('returns stats from the most recent agent:result', () => {
    const old = makeResultEvent({
      perCallContextStats: {
        inputTokens: 5,
        cacheReadInputTokens: 50000,
        cacheCreationInputTokens: 10000,
      },
    });

    const recent = makeResultEvent({
      perCallContextStats: {
        inputTokens: 10,
        cacheReadInputTokens: 150000,
        cacheCreationInputTokens: 30000,
      },
    });

    // getLatestContextStats scans from end, so last event wins
    const stats = getLatestContextStats([old, recent]);
    // recent: 10 + 150000 + 30000 = 180010
    expect(stats?.inputTokens).toBe(180010);
  });

  it('skips agent:result events without modelUsage', () => {
    const noUsage: AgendoEvent = {
      id: 2,
      sessionId: 's',
      ts: 0,
      type: 'agent:result',
      costUsd: null,
      turns: null,
      durationMs: null,
    };
    const withUsage = makeResultEvent({
      perCallContextStats: {
        inputTokens: 5,
        cacheReadInputTokens: 60000,
        cacheCreationInputTokens: 10000,
      },
    });

    // noUsage comes after withUsage but has no modelUsage — falls through to withUsage
    const stats = getLatestContextStats([withUsage, noUsage]);
    // perCallContextStats: 5 + 60000 + 10000 = 70005
    expect(stats?.inputTokens).toBe(70005);
  });
});

describe('fmtTokens', () => {
  it('formats thousands', () => {
    expect(fmtTokens(1500)).toBe('2K');
    expect(fmtTokens(1000)).toBe('1K');
    expect(fmtTokens(50000)).toBe('50K');
  });

  it('formats millions', () => {
    expect(fmtTokens(1_200_000)).toBe('1.2M');
  });

  it('formats small numbers', () => {
    expect(fmtTokens(42)).toBe('42');
    expect(fmtTokens(999)).toBe('999');
  });
});

describe('fmtPct', () => {
  it('shows <1% for tiny non-zero values', () => {
    expect(fmtPct(0.001)).toBe('<1%');
    expect(fmtPct(0.004)).toBe('<1%');
  });

  it('shows 0% for zero', () => {
    expect(fmtPct(0)).toBe('0%');
  });

  it('shows rounded percent', () => {
    expect(fmtPct(0.746)).toBe('75%');
    expect(fmtPct(1.0)).toBe('100%');
  });
});

describe('ctxBarWidth', () => {
  it('caps at 100%', () => {
    expect(ctxBarWidth(1.5)).toBe('max(3px, 100%)');
  });

  it('returns percentage for normal values', () => {
    expect(ctxBarWidth(0.5)).toBe('max(3px, 50%)');
  });
});

describe('ctxBarColor', () => {
  it('returns red/orange for >80%', () => {
    expect(ctxBarColor(0.9)).toBe('oklch(0.65 0.22 25)');
  });

  it('returns amber for 60-80%', () => {
    expect(ctxBarColor(0.7)).toBe('oklch(0.72 0.18 60)');
  });

  it('returns purple for ≤60%', () => {
    expect(ctxBarColor(0.5)).toBe('oklch(0.65 0.18 280)');
  });
});
