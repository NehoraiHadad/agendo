import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { replayEventsAsSSE, type ReplayableEvent } from '../replay';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeController(): {
  enqueue: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  mock: ReadableStreamDefaultController<Uint8Array>;
} {
  const enqueue = vi.fn();
  const close = vi.fn();
  const mock = { enqueue, close } as unknown as ReadableStreamDefaultController<Uint8Array>;
  return { enqueue, close, mock };
}

const decoder = new TextDecoder();

function decodeCall(call: unknown[]): string {
  const arg = call[0];
  if (arg instanceof Uint8Array) return decoder.decode(arg);
  return String(arg);
}

/** Extract all frames emitted via enqueue, decoded to strings. */
function allFrames(enqueue: ReturnType<typeof vi.fn>): string[] {
  return enqueue.mock.calls.map((c) => decodeCall(c));
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const THREE_EVENTS: ReplayableEvent[] = [
  { atMs: 0, type: 'agent:text-delta', payload: { text: 'Hello' } },
  { atMs: 100, type: 'agent:text-delta', payload: { text: 'World' } },
  { atMs: 200, type: 'session:done', payload: {} },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('replayEventsAsSSE', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 1. Ordering: 3 events in correct order
  // -------------------------------------------------------------------------
  it('1. emits 3 events in the correct SSE framing order', () => {
    const { enqueue, mock } = makeController();

    replayEventsAsSSE(THREE_EVENTS, mock, { heartbeatMs: 999999 });
    vi.advanceTimersByTime(300);

    const frames = allFrames(enqueue);
    // Filter to event frames only (they start with "id:")
    const eventFrames = frames.filter((f) => f.startsWith('id:'));
    expect(eventFrames).toHaveLength(3);

    expect(eventFrames[0]).toBe(
      `id: 1\nevent: agent:text-delta\ndata: ${JSON.stringify({ text: 'Hello' })}\n\n`,
    );
    expect(eventFrames[1]).toBe(
      `id: 2\nevent: agent:text-delta\ndata: ${JSON.stringify({ text: 'World' })}\n\n`,
    );
    expect(eventFrames[2]).toBe(`id: 3\nevent: session:done\ndata: ${JSON.stringify({})}\n\n`);
  });

  // -------------------------------------------------------------------------
  // 2. Timing: events fire at the right times
  // -------------------------------------------------------------------------
  it('2. respects atMs timing — fires events at the correct moments', () => {
    const { enqueue, mock } = makeController();

    replayEventsAsSSE(THREE_EVENTS, mock, { heartbeatMs: 999999 });

    // At t=50: only first event (atMs=0) should have fired
    vi.advanceTimersByTime(50);
    expect(allFrames(enqueue).filter((f) => f.startsWith('id:'))).toHaveLength(1);

    // At t=150 (50+100): events 0 and 1 should have fired
    vi.advanceTimersByTime(100);
    expect(allFrames(enqueue).filter((f) => f.startsWith('id:'))).toHaveLength(2);

    // At t=250 (50+100+100): all 3 should have fired
    vi.advanceTimersByTime(100);
    expect(allFrames(enqueue).filter((f) => f.startsWith('id:'))).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 3. Speed multiplier: speed=2 halves wait times
  // -------------------------------------------------------------------------
  it('3. speed=2.0 fires all 3 events by t=100ms', () => {
    const { enqueue, mock } = makeController();

    // atMs: 0/100/200 with speed=2 → actual delays: 0/50/100
    replayEventsAsSSE(THREE_EVENTS, mock, { speed: 2, heartbeatMs: 999999 });

    vi.advanceTimersByTime(100);
    const eventFrames = allFrames(enqueue).filter((f) => f.startsWith('id:'));
    expect(eventFrames).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // 4. Heartbeats: 4 heartbeat frames at t=5/10/15/20k (no events)
  // -------------------------------------------------------------------------
  it('4. emits 4 heartbeat frames at t=5k/10k/15k/20k with heartbeatMs=5000', () => {
    const { enqueue, mock } = makeController();

    // One event far in the future to keep the replay alive past t=20k
    const farEvent: ReplayableEvent = { atMs: 25000, type: 'test', payload: {} };

    replayEventsAsSSE([farEvent], mock, { heartbeatMs: 5000 });

    vi.advanceTimersByTime(20000);

    const heartbeatFrames = allFrames(enqueue).filter((f) => f === ': heartbeat\n\n');
    expect(heartbeatFrames).toHaveLength(4);
  });

  // -------------------------------------------------------------------------
  // 5. onComplete fires after last event + 100ms grace
  // -------------------------------------------------------------------------
  it('5. calls onComplete after the last event plus 100ms grace', () => {
    const { mock } = makeController();
    const onComplete = vi.fn();

    replayEventsAsSSE(THREE_EVENTS, mock, { heartbeatMs: 999999, onComplete });

    // At t=299, the last event has fired (atMs=200) but 100ms grace not elapsed
    vi.advanceTimersByTime(299);
    expect(onComplete).not.toHaveBeenCalled();

    // At t=300+ the grace period has elapsed
    vi.advanceTimersByTime(2);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 6. Abort signal: only events before abort are enqueued, close called once
  // -------------------------------------------------------------------------
  it('6. abort signal stops replay — only pre-abort events enqueued, close called once', () => {
    const { enqueue, close, mock } = makeController();
    const onComplete = vi.fn();
    const ac = new AbortController();

    // Spread events at 0/1000/2000 so abort at t=500 only catches the first
    const spreadEvents: ReplayableEvent[] = [
      { atMs: 0, type: 'agent:text-delta', payload: { text: 'A' } },
      { atMs: 1000, type: 'agent:text-delta', payload: { text: 'B' } },
      { atMs: 2000, type: 'session:done', payload: {} },
    ];

    replayEventsAsSSE(spreadEvents, mock, {
      heartbeatMs: 999999,
      signal: ac.signal,
      onComplete,
    });

    // Advance to t=500: only event at atMs=0 has fired, events at 1000/2000 have not
    vi.advanceTimersByTime(500);
    expect(allFrames(enqueue).filter((f) => f.startsWith('id:'))).toHaveLength(1);

    // Abort
    ac.abort();

    // Advance past the remaining timeouts
    vi.advanceTimersByTime(3000);

    // Still only 1 event enqueued
    expect(allFrames(enqueue).filter((f) => f.startsWith('id:'))).toHaveLength(1);
    // close called exactly once
    expect(close).toHaveBeenCalledOnce();
    // onComplete must NOT be called on abort
    expect(onComplete).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. Cleanup function: same as abort but via returned cleanup
  // -------------------------------------------------------------------------
  it('7. returned cleanup function stops replay — only pre-cleanup events enqueued', () => {
    const { enqueue, close, mock } = makeController();
    const onComplete = vi.fn();

    // Spread events at 0/1000/2000 so cleanup at t=500 only catches the first
    const spreadEvents: ReplayableEvent[] = [
      { atMs: 0, type: 'agent:text-delta', payload: { text: 'A' } },
      { atMs: 1000, type: 'agent:text-delta', payload: { text: 'B' } },
      { atMs: 2000, type: 'session:done', payload: {} },
    ];

    const cleanup = replayEventsAsSSE(spreadEvents, mock, {
      heartbeatMs: 999999,
      onComplete,
    });

    // Advance to t=500: only event at atMs=0 has fired
    vi.advanceTimersByTime(500);
    expect(allFrames(enqueue).filter((f) => f.startsWith('id:'))).toHaveLength(1);

    // Call cleanup
    cleanup();

    // Advance past the remaining timeouts
    vi.advanceTimersByTime(3000);

    expect(allFrames(enqueue).filter((f) => f.startsWith('id:'))).toHaveLength(1);
    expect(close).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. Enqueue throw: if enqueue throws on 2nd call, cleanup runs, no further enqueues
  // -------------------------------------------------------------------------
  it('8. enqueue throw causes cleanup — no further enqueues after throw', () => {
    let callCount = 0;
    const enqueue = vi.fn<(arg: Uint8Array) => void>(() => {
      callCount++;
      if (callCount >= 2) throw new Error('Stream closed');
    });
    const close = vi.fn();
    const mock = { enqueue, close } as unknown as ReadableStreamDefaultController<Uint8Array>;

    replayEventsAsSSE(THREE_EVENTS, mock, { heartbeatMs: 999999 });

    // Advance past all event times
    vi.advanceTimersByTime(300);

    // Only 2 calls: 1st succeeded, 2nd threw and stopped replay
    expect(enqueue).toHaveBeenCalledTimes(2);
    // close called once from the error path
    expect(close).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // 9. Sequential IDs: events increment 1/2/3; heartbeats use comment frame
  // -------------------------------------------------------------------------
  it('9. event IDs increment sequentially; heartbeats do not use id: frame', () => {
    const { enqueue, mock } = makeController();

    // events at 0 and 20000 with heartbeat at 5000
    const events: ReplayableEvent[] = [
      { atMs: 0, type: 'start', payload: { n: 1 } },
      { atMs: 20000, type: 'end', payload: { n: 2 } },
    ];

    replayEventsAsSSE(events, mock, { heartbeatMs: 5000 });

    vi.advanceTimersByTime(20100);

    const frames = allFrames(enqueue);

    // Find first event frame
    const firstEventIdx = frames.findIndex((f) => f.startsWith('id: 1'));
    expect(firstEventIdx).toBeGreaterThanOrEqual(0);
    expect(frames[firstEventIdx]).toContain('id: 1\n');

    // There should be heartbeat frames between the two events
    const heartbeatFrames = frames.filter((f) => f === ': heartbeat\n\n');
    expect(heartbeatFrames.length).toBeGreaterThan(0);

    // Heartbeat frames must not contain 'id:' prefix
    for (const hb of heartbeatFrames) {
      expect(hb).not.toContain('id:');
      expect(hb).toBe(': heartbeat\n\n');
    }

    // Second event frame should have id: 2
    const secondEventIdx = frames.findIndex((f) => f.startsWith('id: 2'));
    expect(secondEventIdx).toBeGreaterThanOrEqual(0);
    expect(frames[secondEventIdx]).toContain('id: 2\n');
  });

  // -------------------------------------------------------------------------
  // 10. Empty events array: no crash; onComplete fires at t=0+grace; close called
  // -------------------------------------------------------------------------
  it('10. empty events array: no crash, onComplete fires at t=100ms, close called once', () => {
    const { close, mock } = makeController();
    const onComplete = vi.fn();

    replayEventsAsSSE([], mock, { heartbeatMs: 999999, onComplete });

    // Before grace period: nothing yet
    vi.advanceTimersByTime(99);
    expect(onComplete).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    // After 100ms grace
    vi.advanceTimersByTime(2);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
