import { describe, it, expect, vi } from 'vitest';
import type { SessionControlCtx } from '@/lib/worker/session-control-handlers';
import type { AgendoControl } from '@/lib/realtime/events';
import { ExitContext } from '@/lib/worker/session-exit-logic';

/** Build a minimal mock SessionControlCtx with sensible defaults. */
function makeCtx(overrides?: Partial<SessionControlCtx>): SessionControlCtx {
  return {
    session: { id: 'sess-1', permissionMode: 'default' } as SessionControlCtx['session'],
    adapter: {
      steer: vi.fn(),
      rollback: vi.fn(),
    } as unknown as SessionControlCtx['adapter'],
    managedProcess: null,
    sigkillTimers: [],
    approvalHandler: {
      pushToolResult: vi.fn(),
      takeResolver: vi.fn(),
      clearSuppressed: vi.fn(),
      drain: vi.fn(),
      persistAllowedTool: vi.fn(),
    } as unknown as SessionControlCtx['approvalHandler'],
    activityTracker: {
      recordActivity: vi.fn(),
    } as unknown as SessionControlCtx['activityTracker'],
    activeToolUseIds: new Set<string>(),
    emitEvent: vi.fn().mockResolvedValue({ id: 1 }),
    transitionTo: vi.fn().mockResolvedValue(undefined),
    exitContext: new ExitContext(),
    pushMessage: vi.fn().mockResolvedValue(undefined),
    makeCtrl: vi.fn(),
    ...overrides,
  };
}

describe('handleRedirect', () => {
  it('pushes the newPrompt via ctx.pushMessage', async () => {
    const { handleRedirect } = await import('@/lib/worker/session-control-handlers');
    const control = { type: 'redirect', newPrompt: 'Go fix the bug' } as Extract<
      AgendoControl,
      { type: 'redirect' }
    >;
    const ctx = makeCtx();
    await handleRedirect(control, ctx);
    expect(ctx.pushMessage).toHaveBeenCalledWith('Go fix the bug');
  });
});

describe('handleToolResult', () => {
  it('calls approvalHandler.pushToolResult when status is active', async () => {
    const { handleToolResult } = await import('@/lib/worker/session-control-handlers');
    const control = {
      type: 'tool-result',
      toolUseId: 'tu-1',
      content: 'user answer',
    } as Extract<AgendoControl, { type: 'tool-result' }>;
    const ctx = makeCtx();
    // Simulate active status via a status getter
    Object.defineProperty(ctx, '_status', { value: 'active', writable: true });
    await handleToolResult(control, ctx, 'active');
    expect(ctx.approvalHandler.pushToolResult).toHaveBeenCalledWith('tu-1', 'user answer');
  });

  it('does nothing when status is not active or awaiting_input', async () => {
    const { handleToolResult } = await import('@/lib/worker/session-control-handlers');
    const control = {
      type: 'tool-result',
      toolUseId: 'tu-1',
      content: 'user answer',
    } as Extract<AgendoControl, { type: 'tool-result' }>;
    const ctx = makeCtx();
    await handleToolResult(control, ctx, 'idle');
    expect(ctx.approvalHandler.pushToolResult).not.toHaveBeenCalled();
  });
});

describe('handleSteer', () => {
  it('calls adapter.steer with the message', async () => {
    const { handleSteer } = await import('@/lib/worker/session-control-handlers');
    const control = { type: 'steer', message: 'Focus on tests' } as Extract<
      AgendoControl,
      { type: 'steer' }
    >;
    const ctx = makeCtx();
    await handleSteer(control, ctx);
    expect(ctx.adapter.steer).toHaveBeenCalledWith('Focus on tests');
  });

  it('handles adapter without steer gracefully', async () => {
    const { handleSteer } = await import('@/lib/worker/session-control-handlers');
    const control = { type: 'steer', message: 'Focus on tests' } as Extract<
      AgendoControl,
      { type: 'steer' }
    >;
    const ctx = makeCtx({
      adapter: { steer: undefined } as unknown as SessionControlCtx['adapter'],
    });
    // Should not throw
    await handleSteer(control, ctx);
  });
});

describe('handleRollback', () => {
  it('calls adapter.rollback with numTurns', async () => {
    const { handleRollback } = await import('@/lib/worker/session-control-handlers');
    const control = { type: 'rollback', numTurns: 3 } as Extract<
      AgendoControl,
      { type: 'rollback' }
    >;
    const ctx = makeCtx();
    await handleRollback(control, ctx);
    expect(ctx.adapter.rollback).toHaveBeenCalledWith(3);
  });

  it('defaults numTurns to 1', async () => {
    const { handleRollback } = await import('@/lib/worker/session-control-handlers');
    const control = { type: 'rollback' } as Extract<AgendoControl, { type: 'rollback' }>;
    const ctx = makeCtx();
    await handleRollback(control, ctx);
    expect(ctx.adapter.rollback).toHaveBeenCalledWith(1);
  });

  it('handles adapter without rollback gracefully', async () => {
    const { handleRollback } = await import('@/lib/worker/session-control-handlers');
    const control = { type: 'rollback', numTurns: 1 } as Extract<
      AgendoControl,
      { type: 'rollback' }
    >;
    const ctx = makeCtx({
      adapter: { rollback: undefined } as unknown as SessionControlCtx['adapter'],
    });
    // Should not throw
    await handleRollback(control, ctx);
  });
});
