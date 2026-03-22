/**
 * Coalesces rapid events into batches flushed once per animation frame.
 *
 * During SSE catchup, hundreds of events may arrive within a single frame.
 * This utility queues them and flushes once per `requestAnimationFrame`,
 * so consumers get a single batch update instead of N individual updates.
 *
 * During live operation, events typically arrive one at a time, so each
 * frame flushes a batch of 1.
 *
 * @example
 * ```ts
 * const batcher = createRAFBatcher<MyEvent>((batch) => {
 *   store.handleEventBatch(batch);
 * });
 *
 * sse.onMessage = (event) => batcher.push(event);
 *
 * // On unmount:
 * batcher.flush();   // process remaining events synchronously
 * batcher.cancel();  // cancel any pending RAF
 * ```
 */
export interface RAFBatcher<T> {
  /** Queue an item for the next animation frame flush. */
  push: (item: T) => void;
  /** Cancel any pending animation frame without flushing. */
  cancel: () => void;
  /**
   * Synchronously flush all queued items immediately.
   * Use on unmount to ensure no events are lost.
   */
  flush: () => void;
}

export function createRAFBatcher<T>(onFlush: (batch: T[]) => void): RAFBatcher<T> {
  let batch: T[] = [];
  let rafId = 0;

  function flush(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (batch.length === 0) return;
    const items = batch;
    batch = [];
    onFlush(items);
  }

  function push(item: T): void {
    batch.push(item);
    if (!rafId) {
      rafId = requestAnimationFrame(flush);
    }
  }

  function cancel(): void {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    batch = [];
  }

  return { push, cancel, flush };
}
