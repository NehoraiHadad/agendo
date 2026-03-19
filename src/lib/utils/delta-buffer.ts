/**
 * Reusable delta-buffer with periodic flush.
 *
 * Accumulates text fragments and flushes them as a single batch after
 * `flushMs` milliseconds of inactivity. Used to throttle high-frequency
 * streaming deltas (text, thinking) into fewer PG NOTIFY / SSE pushes.
 */
export class DeltaBuffer {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushMs: number,
    private readonly onFlush: (text: string) => void,
  ) {}

  /** Append text and start the flush timer if not already running. */
  append(text: string): void {
    this.buffer += text;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush();
      }, this.flushMs);
    }
  }

  /** Flush accumulated text immediately. No-ops if the buffer is empty. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const text = this.buffer;
    if (!text) return;
    this.buffer = '';
    this.onFlush(text);
  }

  /** Clear the buffer and cancel the timer without flushing. */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }

  /** Alias for clear(). Stops the timer and discards buffered text. */
  destroy(): void {
    this.clear();
  }

  /** Returns the current buffered text (for reading without flushing). */
  get pending(): string {
    return this.buffer;
  }
}
