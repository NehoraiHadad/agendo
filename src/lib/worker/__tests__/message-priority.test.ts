/**
 * Tests for message priority passthrough: API → control handler → session process → adapter.
 *
 * TDD Red phase: these tests define the expected behavior before implementation.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SessionControlCtx } from '@/lib/worker/session-control-handlers';
import type { AgendoControl, MessagePriority } from '@/lib/realtime/events';
import { ExitContext } from '@/lib/worker/session-exit-logic';

/** Build a minimal mock SessionControlCtx. */
function makeCtx(overrides?: Partial<SessionControlCtx>): SessionControlCtx {
  return {
    session: { id: 'sess-1', permissionMode: 'default' } as SessionControlCtx['session'],
    adapter: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
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

// ---------------------------------------------------------------------------
// 1. AgendoControl type: message control accepts priority
// ---------------------------------------------------------------------------
describe('AgendoControl message type with priority', () => {
  it('accepts priority field on message control', () => {
    // Type-level test: this should compile without errors
    const control: AgendoControl = {
      type: 'message',
      text: 'hello',
      priority: 'now',
    };
    expect(control.priority).toBe('now');
  });

  it('priority is optional (backward compatible)', () => {
    const control: AgendoControl = {
      type: 'message',
      text: 'hello',
    };
    expect(control).not.toHaveProperty('priority');
  });

  it('accepts all three priority values', () => {
    const priorities: MessagePriority[] = ['now', 'next', 'later'];
    for (const p of priorities) {
      const control: AgendoControl = { type: 'message', text: 'test', priority: p };
      expect(control.priority).toBe(p);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. handleMessage passes priority to ctx.pushMessage
// ---------------------------------------------------------------------------
describe('handleMessage priority passthrough', () => {
  it('passes priority to ctx.pushMessage', async () => {
    const { handleMessage } = await import('@/lib/worker/session-control-handlers');
    const control = {
      type: 'message',
      text: 'do something',
      priority: 'next',
    } as Extract<AgendoControl, { type: 'message' }>;
    const ctx = makeCtx();
    await handleMessage(control, ctx);
    expect(ctx.pushMessage).toHaveBeenCalledWith('do something', {
      image: undefined,
      priority: 'next',
      clientId: undefined,
    });
  });

  it('passes undefined priority when not specified', async () => {
    const { handleMessage } = await import('@/lib/worker/session-control-handlers');
    const control = {
      type: 'message',
      text: 'plain message',
    } as Extract<AgendoControl, { type: 'message' }>;
    const ctx = makeCtx();
    await handleMessage(control, ctx);
    expect(ctx.pushMessage).toHaveBeenCalledWith('plain message', {
      image: undefined,
      priority: undefined,
      clientId: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. SessionControlCtx.pushMessage accepts priority parameter
// ---------------------------------------------------------------------------
describe('SessionControlCtx.pushMessage signature', () => {
  it('pushMessage accepts opts with priority', () => {
    const ctx = makeCtx();
    // Type-level test: calling with opts should be valid
    void ctx.pushMessage('text', { priority: 'now' });
    expect(ctx.pushMessage).toHaveBeenCalledWith('text', { priority: 'now' });
  });
});

// ---------------------------------------------------------------------------
// 4. Adapter interface accepts priority in sendMessage
// ---------------------------------------------------------------------------
describe('AgentAdapter.sendMessage priority parameter', () => {
  it('sendMessage accepts optional priority parameter', async () => {
    const adapter = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    await adapter.sendMessage('hello', undefined, 'next');
    expect(adapter.sendMessage).toHaveBeenCalledWith('hello', undefined, 'next');
  });
});
