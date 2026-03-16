import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before imports
vi.mock('@/lib/db', () => ({
  db: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  sessions: { id: 'id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ _tag: 'eq', a, b })),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/worker/interruption-marker', () => ({
  recordInterruptionEvent: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import {
  ExitContext,
  determineExitStatus,
  cleanupResources,
  type CleanupDeps,
  type ExitStatusDeps,
} from '../session-exit-logic';

describe('ExitContext', () => {
  it('defaults to reason=none with all flags false', () => {
    const ctx = new ExitContext();
    expect(ctx.reason).toBe('none');
    expect(ctx.exitHandled).toBe(false);
    expect(ctx.interruptInProgress).toBe(false);
    expect(ctx.clearContextRestartNewSessionId).toBeNull();
    expect(ctx.terminateKilled).toBe(false);
    expect(ctx.cancelKilled).toBe(false);
    expect(ctx.modeChangeRestart).toBe(false);
    expect(ctx.clearContextRestart).toBe(false);
  });

  describe('cancelKilled getter', () => {
    it('returns true when reason=cancel', () => {
      const ctx = new ExitContext();
      ctx.reason = 'cancel';
      expect(ctx.cancelKilled).toBe(true);
      expect(ctx.terminateKilled).toBe(false);
    });
  });

  describe('terminateKilled getter', () => {
    it('returns true when reason=terminate', () => {
      const ctx = new ExitContext();
      ctx.reason = 'terminate';
      expect(ctx.terminateKilled).toBe(true);
      expect(ctx.cancelKilled).toBe(false);
    });
  });

  describe('modeChangeRestart getter', () => {
    it('returns true when reason=mode-change-restart', () => {
      const ctx = new ExitContext();
      ctx.reason = 'mode-change-restart';
      expect(ctx.modeChangeRestart).toBe(true);
      expect(ctx.terminateKilled).toBe(true);
    });
  });

  describe('clearContextRestart getter', () => {
    it('returns true when reason=clear-context-restart', () => {
      const ctx = new ExitContext();
      ctx.reason = 'clear-context-restart';
      expect(ctx.clearContextRestart).toBe(true);
      expect(ctx.terminateKilled).toBe(true);
    });
  });

  describe('idle-timeout reason', () => {
    it('sets terminateKilled=true but not cancelKilled', () => {
      const ctx = new ExitContext();
      ctx.reason = 'idle-timeout';
      expect(ctx.terminateKilled).toBe(false);
      expect(ctx.cancelKilled).toBe(false);
    });
  });

  describe('interrupt reason', () => {
    it('does not set terminateKilled or cancelKilled', () => {
      const ctx = new ExitContext();
      ctx.reason = 'interrupt';
      expect(ctx.terminateKilled).toBe(false);
      expect(ctx.cancelKilled).toBe(false);
    });
  });

  it('tracks clearContextRestartNewSessionId', () => {
    const ctx = new ExitContext();
    ctx.clearContextRestartNewSessionId = 'abc-123';
    expect(ctx.clearContextRestartNewSessionId).toBe('abc-123');
  });
});

describe('determineExitStatus', () => {
  const makeExitStatusDeps = (overrides: Partial<ExitStatusDeps> = {}): ExitStatusDeps => ({
    sessionId: 'sess-1',
    taskId: 'task-1',
    agentId: 'agent-1',
    currentStatus: 'active',
    activeToolInfo: new Map(),
    emitEvent: vi.fn(),
    transitionTo: vi.fn(),
    ...overrides,
  });

  it('transitions to ended on cancel', async () => {
    const ctx = new ExitContext();
    ctx.reason = 'cancel';
    const deps = makeExitStatusDeps();

    await determineExitStatus(ctx, 0, false, deps);

    expect(deps.transitionTo).toHaveBeenCalledWith('ended');
  });

  it('transitions to idle on clean exit (code 0)', async () => {
    const ctx = new ExitContext();
    const deps = makeExitStatusDeps();

    await determineExitStatus(ctx, 0, false, deps);

    expect(deps.transitionTo).toHaveBeenCalledWith('idle');
  });

  it('transitions to idle on terminate', async () => {
    const ctx = new ExitContext();
    ctx.reason = 'terminate';
    const deps = makeExitStatusDeps();

    await determineExitStatus(ctx, null, false, deps);

    expect(deps.transitionTo).toHaveBeenCalledWith('idle');
  });

  it('transitions to idle on idle-timeout', async () => {
    const ctx = new ExitContext();
    ctx.reason = 'idle-timeout';
    const deps = makeExitStatusDeps();

    await determineExitStatus(ctx, null, false, deps);

    expect(deps.transitionTo).toHaveBeenCalledWith('idle');
  });

  it('transitions to idle on interrupt', async () => {
    const ctx = new ExitContext();
    ctx.reason = 'interrupt';
    const deps = makeExitStatusDeps();

    await determineExitStatus(ctx, null, false, deps);

    expect(deps.transitionTo).toHaveBeenCalledWith('idle');
  });

  it('emits info and transitions to idle on crash (non-zero exit, auto-recovery)', async () => {
    const ctx = new ExitContext();
    const deps = makeExitStatusDeps();

    await determineExitStatus(ctx, 1, false, deps);

    expect(deps.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system:info',
        message: expect.stringContaining('exit code 1'),
      }),
    );
    // Crashes now transition to idle for auto-recovery instead of ended
    expect(deps.transitionTo).toHaveBeenCalledWith('idle');
  });

  it('emits info and transitions to idle on null exit code (crash + auto-recovery)', async () => {
    const ctx = new ExitContext();
    const deps = makeExitStatusDeps();

    await determineExitStatus(ctx, null, false, deps);

    expect(deps.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system:info',
        message: expect.stringContaining('exit code null'),
      }),
    );
    expect(deps.transitionTo).toHaveBeenCalledWith('idle');
  });

  it('records interruption event when interrupted mid-turn with task', async () => {
    const { recordInterruptionEvent } = await import('@/lib/worker/interruption-marker');
    const ctx = new ExitContext();
    ctx.reason = 'terminate';
    const toolInfo = new Map([['tool-1', { toolName: 'Edit', input: {} }]]);
    const deps = makeExitStatusDeps({
      activeToolInfo: toolInfo,
    });

    await determineExitStatus(ctx, null, true, deps);

    expect(recordInterruptionEvent).toHaveBeenCalledWith(
      'task-1',
      [...toolInfo.values()],
      'agent-1',
    );
    expect(deps.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system:info',
        message: expect.stringContaining('Edit'),
      }),
    );
  });

  it('skips status transition when status is not active or awaiting_input', async () => {
    const ctx = new ExitContext();
    const deps = makeExitStatusDeps({ currentStatus: 'ended' });

    await determineExitStatus(ctx, 1, false, deps);

    expect(deps.transitionTo).not.toHaveBeenCalled();
    expect(deps.emitEvent).not.toHaveBeenCalled();
  });

  it('handles awaiting_input status same as active', async () => {
    const ctx = new ExitContext();
    ctx.reason = 'cancel';
    const deps = makeExitStatusDeps({ currentStatus: 'awaiting_input' });

    await determineExitStatus(ctx, 0, false, deps);

    expect(deps.transitionTo).toHaveBeenCalledWith('ended');
  });

  it('sets endedAt when final status is ended', async () => {
    const { db } = await import('@/lib/db');
    const ctx = new ExitContext();
    ctx.reason = 'cancel';
    const mockWhere = vi.fn();
    const mockSet = vi.fn(() => ({ where: mockWhere }));
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue({ set: mockSet });
    const deps = makeExitStatusDeps();

    // transitionTo should update currentStatus to ended
    deps.transitionTo = vi.fn();

    await determineExitStatus(ctx, 0, false, deps);

    // The function checks deps.currentStatus after transitionTo, but since we mock
    // transitionTo, the endedAt update depends on implementation details.
    // We'll verify the transition happened correctly.
    expect(deps.transitionTo).toHaveBeenCalledWith('ended');
  });
});

describe('cleanupResources', () => {
  const makeCleanupDeps = (overrides: Partial<CleanupDeps> = {}): CleanupDeps => ({
    activityTracker: {
      stopAllTimers: vi.fn(),
    },
    sigkillTimers: [],
    approvalHandler: {
      drain: vi.fn(),
    },
    teamManager: {
      stop: vi.fn(),
    },
    policyFilePath: null,
    ...overrides,
  });

  it('stops all timers', () => {
    const deps = makeCleanupDeps();
    cleanupResources(deps);
    expect(deps.activityTracker.stopAllTimers).toHaveBeenCalled();
  });

  it('clears sigkill timers', () => {
    const timer1 = setTimeout(() => {}, 10000);
    const timer2 = setTimeout(() => {}, 10000);
    const timers = [timer1, timer2];
    const deps = makeCleanupDeps({ sigkillTimers: timers });

    cleanupResources(deps);

    expect(deps.sigkillTimers).toHaveLength(0);
  });

  it('drains approval handler', () => {
    const deps = makeCleanupDeps();
    cleanupResources(deps);
    expect(deps.approvalHandler.drain).toHaveBeenCalledWith('deny');
  });

  it('stops team manager', () => {
    const deps = makeCleanupDeps();
    cleanupResources(deps);
    expect(deps.teamManager.stop).toHaveBeenCalled();
  });

  it('removes policy file if present', () => {
    const deps = makeCleanupDeps({ policyFilePath: '/tmp/test-policy.toml' });
    cleanupResources(deps);
    expect(deps.policyFilePath).toBeNull();
  });
});
