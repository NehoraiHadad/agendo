const encoder = new TextEncoder();

/**
 * A single event in a pre-recorded replay arc.
 */
export interface ReplayableEvent {
  /** Milliseconds from the start of the replay. */
  atMs: number;
  /** The SSE event type (e.g. 'agent:text-delta', 'session:mode-change'). */
  type: string;
  /** The full event payload as it should be serialized in the SSE `data:` field. */
  payload: unknown;
}

export interface ReplayOptions {
  /**
   * Multiplier on the original atMs gaps. Default 1.0.
   * A speed of 2 halves the real wait time (atMs / speed).
   */
  speed?: number;
  /** Heartbeat interval in ms. Default 15000. */
  heartbeatMs?: number;
  /** Optional completion callback fired after the last event is emitted naturally. */
  onComplete?: () => void;
  /** AbortSignal to stop the replay early (e.g. when client disconnects). */
  signal?: AbortSignal;
}

/**
 * Drives a pre-recorded event array through an SSE ReadableStream controller.
 *
 * Each event is serialized as:
 * ```
 * id: <seq>\n
 * event: <type>\n
 * data: <JSON.stringify(payload)>\n\n
 * ```
 * Heartbeats are emitted as SSE comment frames: `: heartbeat\n\n`
 *
 * Returns a cleanup function the route handler can call on close.
 */
export function replayEventsAsSSE(
  events: ReplayableEvent[],
  controller: ReadableStreamDefaultController<Uint8Array>,
  options?: ReplayOptions,
): () => void {
  const speed = options?.speed ?? 1.0;
  const heartbeatMs = options?.heartbeatMs ?? 15000;
  const onComplete = options?.onComplete;
  const signal = options?.signal;

  let closed = false;
  let seq = 0;
  const timeouts: ReturnType<typeof setTimeout>[] = [];

  // Sort defensively by atMs
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);

  /** Safely close the controller exactly once. */
  function safeClose(): void {
    if (closed) return;
    closed = true;
    try {
      controller.close();
    } catch {
      // Already closed or stream in bad state — ignore
    }
  }

  /** Safely enqueue bytes. Returns false if the stream threw (client gone). */
  function safeEnqueue(bytes: Uint8Array): boolean {
    try {
      controller.enqueue(bytes);
      return true;
    } catch {
      cleanup();
      return false;
    }
  }

  /** Cancel all pending timers and close the controller. */
  function cleanup(): void {
    if (closed) return;
    for (const t of timeouts) clearTimeout(t);
    timeouts.length = 0;
    clearInterval(heartbeatInterval);
    safeClose();
  }

  // ---------------------------------------------------------------------------
  // Handle pre-aborted signal synchronously
  // Note: returning `cleanup` here is safe even though `heartbeatInterval` is
  // declared below. `safeClose()` sets `closed = true`, so `cleanup` will
  // early-return before ever referencing `heartbeatInterval`.
  // ---------------------------------------------------------------------------
  if (signal?.aborted) {
    safeClose();
    return cleanup;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat interval
  // ---------------------------------------------------------------------------
  const heartbeatInterval = setInterval(() => {
    if (closed) return;
    safeEnqueue(encoder.encode(': heartbeat\n\n'));
  }, heartbeatMs);

  // ---------------------------------------------------------------------------
  // Schedule each event
  // ---------------------------------------------------------------------------
  for (const event of sorted) {
    const delay = event.atMs / speed;
    const t = setTimeout(() => {
      if (closed) return;
      seq++;
      const frame = `id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
      safeEnqueue(encoder.encode(frame));
    }, delay);
    timeouts.push(t);
  }

  // ---------------------------------------------------------------------------
  // Completion: fire 100ms after the last event's scheduled time
  // ---------------------------------------------------------------------------
  const lastMs = sorted.length > 0 ? sorted[sorted.length - 1].atMs / speed : 0;
  const completionTimer = setTimeout(() => {
    if (closed) return;
    clearInterval(heartbeatInterval);
    onComplete?.();
    safeClose();
  }, lastMs + 100);
  timeouts.push(completionTimer);

  // ---------------------------------------------------------------------------
  // Abort signal listener
  // ---------------------------------------------------------------------------
  if (signal) {
    const onAbort = (): void => {
      cleanup();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return cleanup;
}
