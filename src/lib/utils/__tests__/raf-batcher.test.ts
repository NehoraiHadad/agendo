import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRAFBatcher } from '../raf-batcher';

// Mock requestAnimationFrame / cancelAnimationFrame for node environment
let rafCallbacks: Map<number, FrameRequestCallback>;
let rafIdCounter: number;

beforeEach(() => {
  rafCallbacks = new Map();
  rafIdCounter = 0;

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = ++rafIdCounter;
    rafCallbacks.set(id, cb);
    return id;
  });

  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafCallbacks.delete(id);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Simulate a browser frame tick — runs all pending RAF callbacks. */
function tick(): void {
  const callbacks = [...rafCallbacks.entries()];
  rafCallbacks.clear();
  for (const [, cb] of callbacks) {
    cb(performance.now());
  }
}

describe('createRAFBatcher', () => {
  it('flushes a single event on next frame', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.push(1);
    expect(flushed).toHaveLength(0);

    tick();
    expect(flushed).toEqual([[1]]);
  });

  it('coalesces multiple events into a single batch', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.push(1);
    batcher.push(2);
    batcher.push(3);

    tick();
    expect(flushed).toEqual([[1, 2, 3]]);
  });

  it('schedules only one RAF per batch window', () => {
    const batcher = createRAFBatcher<number>(() => {});

    batcher.push(1);
    batcher.push(2);
    batcher.push(3);

    // Only one RAF should have been scheduled
    expect(rafCallbacks.size).toBe(1);
  });

  it('handles multiple frame cycles independently', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.push(1);
    tick();

    batcher.push(2);
    batcher.push(3);
    tick();

    expect(flushed).toEqual([[1], [2, 3]]);
  });

  it('flush() processes remaining events synchronously', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.push(1);
    batcher.push(2);

    batcher.flush();
    expect(flushed).toEqual([[1, 2]]);

    // RAF should have been cancelled
    expect(rafCallbacks.size).toBe(0);
  });

  it('flush() is a no-op when batch is empty', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.flush();
    expect(flushed).toHaveLength(0);
  });

  it('cancel() discards pending events without flushing', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.push(1);
    batcher.push(2);
    batcher.cancel();

    tick();
    expect(flushed).toHaveLength(0);
    expect(rafCallbacks.size).toBe(0);
  });

  it('can push new events after cancel', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.push(1);
    batcher.cancel();

    batcher.push(2);
    tick();
    expect(flushed).toEqual([[2]]);
  });

  it('can push new events after flush', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.push(1);
    batcher.flush();

    batcher.push(2);
    tick();
    expect(flushed).toEqual([[1], [2]]);
  });

  it('handles flush followed by tick without double-processing', () => {
    const flushed: number[][] = [];
    const batcher = createRAFBatcher<number>((batch) => flushed.push(batch));

    batcher.push(1);
    batcher.flush();
    tick(); // RAF was cancelled by flush, so this should be a no-op

    expect(flushed).toEqual([[1]]);
  });
});
