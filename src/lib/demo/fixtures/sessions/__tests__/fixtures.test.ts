import { describe, it, expect } from 'vitest';

// These imports will fail until the fixtures are implemented — that's intentional (Red phase).
import { claudeExploreEvents } from '../claude-explore';
import { codexRefactorEvents } from '../codex-refactor';
import { geminiPlanEvents } from '../gemini-plan';
import { DEMO_SESSION_EVENTS } from '../index';
import type { ReplayableEvent } from '@/lib/demo/sse/factories';

const CLAUDE_EXPLORE_ID = '77777777-7777-4777-a777-777777777777';
const CODEX_REFACTOR_ID = '88888888-8888-4888-a888-888888888888';
const GEMINI_PLAN_ID = '99999999-9999-4999-a999-999999999999';

function assertFixture(
  events: ReplayableEvent[],
  sessionId: string,
  opts: {
    /** Must include a session:init */
    hasStart: boolean;
    /** Must include agent:result or session:state ended */
    hasLifecycleEnd?: boolean;
    /** Must end with agent:tool-approval (blocked) */
    endsWithApproval?: boolean;
  },
): void {
  // 1. Non-empty
  expect(events.length).toBeGreaterThan(0);

  // 2. Chronological atMs order
  for (let i = 1; i < events.length; i++) {
    expect(events[i].atMs).toBeGreaterThanOrEqual(events[i - 1].atMs);
  }

  // 3. All events reference the correct sessionId
  for (const ev of events) {
    expect(ev.sessionId).toBe(sessionId);
  }

  // 4. At least one session:init
  if (opts.hasStart) {
    const startEvents = events.filter((e) => e.type === 'session:init');
    expect(startEvents.length).toBeGreaterThanOrEqual(1);
  }

  // 5. Lifecycle end checks
  if (opts.hasLifecycleEnd) {
    const hasResult = events.some((e) => e.type === 'agent:result');
    const hasStateEnded = events.some(
      (e) =>
        e.type === 'session:state' &&
        e.payload &&
        (e.payload as { status?: string }).status === 'ended',
    );
    expect(hasResult || hasStateEnded).toBe(true);
  }

  // 6. Blocked arc ends with a tool-approval pending (no session:state ended)
  if (opts.endsWithApproval) {
    const hasApproval = events.some((e) => e.type === 'agent:tool-approval');
    expect(hasApproval).toBe(true);
    // Should NOT have ended
    const hasEnded = events.some(
      (e) =>
        e.type === 'session:state' &&
        e.payload &&
        (e.payload as { status?: string }).status === 'ended',
    );
    expect(hasEnded).toBe(false);
  }
}

describe('demo fixture: claude-explore (90s running arc)', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(claudeExploreEvents)).toBe(true);
    expect(claudeExploreEvents.length).toBeGreaterThan(0);
  });

  it('events are in chronological order', () => {
    for (let i = 1; i < claudeExploreEvents.length; i++) {
      expect(claudeExploreEvents[i].atMs).toBeGreaterThanOrEqual(claudeExploreEvents[i - 1].atMs);
    }
  });

  it('all events reference the correct sessionId', () => {
    for (const ev of claudeExploreEvents) {
      expect(ev.sessionId).toBe(CLAUDE_EXPLORE_ID);
    }
  });

  it('has at least one session:init event', () => {
    const inits = claudeExploreEvents.filter((e) => e.type === 'session:init');
    expect(inits.length).toBeGreaterThanOrEqual(1);
  });

  it('has at least one agent:result event (running session has result but no session:end)', () => {
    const results = claudeExploreEvents.filter((e) => e.type === 'agent:result');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT have a session:state ended event (session is still running)', () => {
    const ended = claudeExploreEvents.filter(
      (e) =>
        e.type === 'session:state' &&
        e.payload &&
        (e.payload as { status?: string }).status === 'ended',
    );
    expect(ended.length).toBe(0);
  });

  it('has at least one agent:text-delta event', () => {
    const deltas = claudeExploreEvents.filter((e) => e.type === 'agent:text-delta');
    expect(deltas.length).toBeGreaterThan(0);
  });

  it('has tool-start / tool-end pairs with matching toolUseIds', () => {
    const starts = claudeExploreEvents.filter((e) => e.type === 'agent:tool-start');
    const ends = claudeExploreEvents.filter((e) => e.type === 'agent:tool-end');
    expect(starts.length).toBeGreaterThan(0);
    expect(ends.length).toBe(starts.length);

    const startIds = new Set(starts.map((e) => (e.payload as { toolUseId: string }).toolUseId));
    const endIds = new Set(ends.map((e) => (e.payload as { toolUseId: string }).toolUseId));
    for (const id of startIds) {
      expect(endIds.has(id)).toBe(true);
    }
  });

  it('has a permission-request (agent:tool-approval) event', () => {
    const approvals = claudeExploreEvents.filter((e) => e.type === 'agent:tool-approval');
    expect(approvals.length).toBeGreaterThanOrEqual(1);
  });

  it('has a session:mode-change event', () => {
    const modeChanges = claudeExploreEvents.filter((e) => e.type === 'session:mode-change');
    expect(modeChanges.length).toBeGreaterThanOrEqual(1);
  });

  it('all event atMs values are non-negative', () => {
    for (const ev of claudeExploreEvents) {
      expect(ev.atMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('demo fixture: codex-refactor (60s completed arc)', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(codexRefactorEvents)).toBe(true);
    expect(codexRefactorEvents.length).toBeGreaterThan(0);
  });

  it('events are in chronological order', () => {
    for (let i = 1; i < codexRefactorEvents.length; i++) {
      expect(codexRefactorEvents[i].atMs).toBeGreaterThanOrEqual(codexRefactorEvents[i - 1].atMs);
    }
  });

  it('all events reference the correct sessionId', () => {
    for (const ev of codexRefactorEvents) {
      expect(ev.sessionId).toBe(CODEX_REFACTOR_ID);
    }
  });

  it('has at least one session:init event', () => {
    const inits = codexRefactorEvents.filter((e) => e.type === 'session:init');
    expect(inits.length).toBeGreaterThanOrEqual(1);
  });

  it('has an agent:result event', () => {
    const results = codexRefactorEvents.filter((e) => e.type === 'agent:result');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('has a session:state ended event (session is completed)', () => {
    const ended = codexRefactorEvents.filter(
      (e) =>
        e.type === 'session:state' &&
        e.payload &&
        (e.payload as { status?: string }).status === 'ended',
    );
    expect(ended.length).toBeGreaterThanOrEqual(1);
  });

  it('has tool-start / tool-end pairs with matching toolUseIds', () => {
    const starts = codexRefactorEvents.filter((e) => e.type === 'agent:tool-start');
    const ends = codexRefactorEvents.filter((e) => e.type === 'agent:tool-end');
    expect(starts.length).toBeGreaterThan(0);
    expect(ends.length).toBe(starts.length);

    const startIds = new Set(starts.map((e) => (e.payload as { toolUseId: string }).toolUseId));
    const endIds = new Set(ends.map((e) => (e.payload as { toolUseId: string }).toolUseId));
    for (const id of startIds) {
      expect(endIds.has(id)).toBe(true);
    }
  });

  it('all event atMs values are non-negative', () => {
    for (const ev of codexRefactorEvents) {
      expect(ev.atMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('demo fixture: gemini-plan (45s blocked arc)', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(geminiPlanEvents)).toBe(true);
    expect(geminiPlanEvents.length).toBeGreaterThan(0);
  });

  it('events are in chronological order', () => {
    for (let i = 1; i < geminiPlanEvents.length; i++) {
      expect(geminiPlanEvents[i].atMs).toBeGreaterThanOrEqual(geminiPlanEvents[i - 1].atMs);
    }
  });

  it('all events reference the correct sessionId', () => {
    for (const ev of geminiPlanEvents) {
      expect(ev.sessionId).toBe(GEMINI_PLAN_ID);
    }
  });

  it('has at least one session:init event', () => {
    const inits = geminiPlanEvents.filter((e) => e.type === 'session:init');
    expect(inits.length).toBeGreaterThanOrEqual(1);
  });

  it('has an agent:tool-approval event (awaiting user)', () => {
    const approvals = geminiPlanEvents.filter((e) => e.type === 'agent:tool-approval');
    expect(approvals.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT have a session:state ended event (session is blocked)', () => {
    const ended = geminiPlanEvents.filter(
      (e) =>
        e.type === 'session:state' &&
        e.payload &&
        (e.payload as { status?: string }).status === 'ended',
    );
    expect(ended.length).toBe(0);
  });

  it('all event atMs values are non-negative', () => {
    for (const ev of geminiPlanEvents) {
      expect(ev.atMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('DEMO_SESSION_EVENTS map', () => {
  it('contains all three session IDs', () => {
    expect(DEMO_SESSION_EVENTS[CLAUDE_EXPLORE_ID]).toBeDefined();
    expect(DEMO_SESSION_EVENTS[CODEX_REFACTOR_ID]).toBeDefined();
    expect(DEMO_SESSION_EVENTS[GEMINI_PLAN_ID]).toBeDefined();
  });

  it('maps sessionId keys to the correct fixture arrays', () => {
    expect(DEMO_SESSION_EVENTS[CLAUDE_EXPLORE_ID]).toBe(claudeExploreEvents);
    expect(DEMO_SESSION_EVENTS[CODEX_REFACTOR_ID]).toBe(codexRefactorEvents);
    expect(DEMO_SESSION_EVENTS[GEMINI_PLAN_ID]).toBe(geminiPlanEvents);
  });

  it('each fixture passes the base assertions', () => {
    assertFixture(DEMO_SESSION_EVENTS[CLAUDE_EXPLORE_ID], CLAUDE_EXPLORE_ID, {
      hasStart: true,
    });
    assertFixture(DEMO_SESSION_EVENTS[CODEX_REFACTOR_ID], CODEX_REFACTOR_ID, {
      hasStart: true,
      hasLifecycleEnd: true,
    });
    assertFixture(DEMO_SESSION_EVENTS[GEMINI_PLAN_ID], GEMINI_PLAN_ID, {
      hasStart: true,
      endsWithApproval: true,
    });
  });
});
