import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RuntimeManager } from '@/lib/worker/runtime-manager';

/** Minimal mock of SessionProcess with the methods RuntimeManager calls. */
function mockProc(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    markTerminating: vi.fn(),
    terminate: vi.fn(),
    waitForExit: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as import('@/lib/worker/session-process').SessionProcess;
}

describe('RuntimeManager', () => {
  let mgr: RuntimeManager;

  beforeEach(() => {
    mgr = new RuntimeManager('worker-1');
  });

  // ── register / has / getProcess ──────────────────────────────────

  it('register() makes the session available via has() and getProcess()', () => {
    const proc = mockProc();
    mgr.register('s1', proc);
    expect(mgr.has('s1')).toBe(true);
    expect(mgr.getProcess('s1')).toBe(proc);
  });

  it('has() returns false for unknown session', () => {
    expect(mgr.has('unknown')).toBe(false);
  });

  it('getProcess() returns undefined for unknown session', () => {
    expect(mgr.getProcess('unknown')).toBeUndefined();
  });

  // ── markLive ─────────────────────────────────────────────────────

  it('markLive() moves session to live set', () => {
    const proc = mockProc();
    mgr.register('s1', proc);
    expect(mgr.liveCount).toBe(0);

    mgr.markLive('s1');
    expect(mgr.liveCount).toBe(1);
  });

  it('markLive() is a no-op if session is not registered', () => {
    // Should not throw
    mgr.markLive('unknown');
    expect(mgr.liveCount).toBe(0);
  });

  // ── remove ───────────────────────────────────────────────────────

  it('remove() deletes from both maps when proc identity matches', () => {
    const proc = mockProc();
    mgr.register('s1', proc);
    mgr.markLive('s1');

    mgr.remove('s1', proc);
    expect(mgr.has('s1')).toBe(false);
    expect(mgr.activeCount).toBe(0);
    expect(mgr.liveCount).toBe(0);
  });

  it('remove() skips deletion when proc identity does NOT match (replaced by newer)', () => {
    const oldProc = mockProc();
    const newProc = mockProc();
    mgr.register('s1', oldProc);
    mgr.markLive('s1');

    // Simulate a newer runSession replacing the entry
    mgr.register('s1', newProc);
    mgr.markLive('s1');

    // Old proc exits — should NOT remove the new one
    mgr.remove('s1', oldProc);
    expect(mgr.has('s1')).toBe(true);
    expect(mgr.getProcess('s1')).toBe(newProc);
    expect(mgr.liveCount).toBe(1);
  });

  // ── counts ───────────────────────────────────────────────────────

  it('activeCount reflects all registered sessions', () => {
    mgr.register('s1', mockProc());
    mgr.register('s2', mockProc());
    expect(mgr.activeCount).toBe(2);
  });

  it('liveCount reflects only markLive() sessions', () => {
    mgr.register('s1', mockProc());
    mgr.register('s2', mockProc());
    mgr.markLive('s1');
    expect(mgr.liveCount).toBe(1);
  });

  // ── markAllTerminating ───────────────────────────────────────────

  it('markAllTerminating() calls markTerminating() on every proc synchronously', () => {
    const p1 = mockProc();
    const p2 = mockProc();
    mgr.register('s1', p1);
    mgr.register('s2', p2);

    mgr.markAllTerminating();

    expect(p1.markTerminating).toHaveBeenCalledOnce();
    expect(p2.markTerminating).toHaveBeenCalledOnce();
  });

  // ── getLiveProcs / getAllProcs ────────────────────────────────────

  it('getLiveProcs() returns only live procs', () => {
    const p1 = mockProc();
    const p2 = mockProc();
    mgr.register('s1', p1);
    mgr.register('s2', p2);
    mgr.markLive('s1');

    expect(mgr.getLiveProcs()).toEqual([p1]);
  });

  it('getAllProcs() returns all registered procs', () => {
    const p1 = mockProc();
    const p2 = mockProc();
    mgr.register('s1', p1);
    mgr.register('s2', p2);

    const all = mgr.getAllProcs();
    expect(all).toHaveLength(2);
    expect(all).toContain(p1);
    expect(all).toContain(p2);
  });

  // ── shutdown ─────────────────────────────────────────────────────

  it('shutdown() terminates all live procs and waits for exit', async () => {
    const p1 = mockProc();
    const p2 = mockProc();
    mgr.register('s1', p1);
    mgr.register('s2', p2);
    mgr.markLive('s1');
    mgr.markLive('s2');

    await mgr.shutdown(5000);

    expect(p1.terminate).toHaveBeenCalledOnce();
    expect(p2.terminate).toHaveBeenCalledOnce();
    expect(p1.waitForExit).toHaveBeenCalledOnce();
    expect(p2.waitForExit).toHaveBeenCalledOnce();
  });

  it('shutdown() respects grace timeout', async () => {
    // Create a proc whose waitForExit never resolves
    const hangingProc = mockProc({
      waitForExit: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
    });
    mgr.register('s1', hangingProc);
    mgr.markLive('s1');

    const start = Date.now();
    await mgr.shutdown(100); // 100ms grace
    const elapsed = Date.now() - start;

    expect(hangingProc.terminate).toHaveBeenCalledOnce();
    // Should have returned within ~200ms (100ms grace + overhead)
    expect(elapsed).toBeLessThan(500);
  });

  it('shutdown() is a no-op when no live procs exist', async () => {
    mgr.register('s1', mockProc());
    // Not marked live
    await mgr.shutdown(5000);
    // Should complete without error
  });

  // ── workerId ─────────────────────────────────────────────────────

  it('exposes workerId', () => {
    expect(mgr.workerId).toBe('worker-1');
  });
});
