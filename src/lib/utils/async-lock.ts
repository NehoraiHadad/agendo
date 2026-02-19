/**
 * AsyncLock — a simple async mutex for serializing concurrent operations.
 *
 * Prevents interleaved bytes when stdin writes race with each other
 * (e.g. a new message arrives during an interrupt window, or two concurrent
 * sendMessage calls overlap on the same stream).
 *
 * Usage:
 *   private lock = new AsyncLock();
 *   async sendMessage(msg: string) {
 *     return this.lock.acquire(() => this.doSend(msg));
 *   }
 *
 * Inspired by slopus/happy packages/happy-cli/src/utils/AsyncLock.ts
 */
export class AsyncLock {
  private queue: Promise<void> = Promise.resolve();

  /**
   * Acquire the lock and run fn. The next acquire() call waits until fn
   * resolves or rejects before running its own fn.
   */
  acquire<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    // Attach a no-op error handler so errors from `fn` don't propagate into
    // the queue chain (they still reject the returned Promise normally).
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
