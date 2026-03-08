/**
 * Generic NDJSON (newline-delimited JSON) stream utilities.
 *
 * Provides:
 * - parseNdjsonLine()   — parse a single line with optional validation
 * - ndjsonStream()      — async generator that yields parsed objects from a Readable
 */

import type { Readable } from 'node:stream';

/**
 * Parse a single NDJSON line. Returns null for blank lines or invalid JSON.
 * If `validate` is provided, returns null when validation fails.
 */
export function parseNdjsonLine<T = unknown>(
  line: string,
  validate?: (obj: unknown) => obj is T,
): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (validate && !validate(parsed)) return null;
    return parsed as T;
  } catch {
    return null;
  }
}

export interface NdjsonStreamOpts<T> {
  /** The readable stream to consume (e.g. ChildProcess.stdout). */
  stream: Readable;
  /** Optional validator/type guard for parsed objects. */
  validate?: (obj: unknown) => obj is T;
  /**
   * Called when the underlying source ends. Receives the exit code
   * (null if not applicable). Throw to signal an error to the consumer.
   */
  onClose?: (code: number | null) => void;
}

/**
 * Async generator that reads NDJSON from a Readable stream.
 *
 * Handles line buffering across TCP chunk boundaries and yields
 * parsed+validated objects. Flushes any partial line on stream close.
 */
export async function* ndjsonStream<T = unknown>(opts: NdjsonStreamOpts<T>): AsyncGenerator<T> {
  const { stream, validate, onClose } = opts;

  // Async queue: shared between event handlers and the generator consumer
  const queue: Array<T | Error | null> = [];
  let resolveNext: (() => void) | null = null;

  function push(item: T | Error | null) {
    queue.push(item);
    resolveNext?.();
    resolveNext = null;
  }

  let lineBuffer = '';

  stream.on('data', (chunk: Buffer) => {
    const combined = lineBuffer + (Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : chunk);
    const parts = combined.split('\n');
    lineBuffer = parts.pop() ?? '';
    for (const line of parts) {
      const parsed = parseNdjsonLine<T>(line, validate);
      if (parsed !== null) push(parsed);
    }
  });

  stream.on('error', (err) => push(err));

  stream.on('close', () => {
    // Flush any partial data remaining in the buffer
    if (lineBuffer.trim()) {
      const parsed = parseNdjsonLine<T>(lineBuffer, validate);
      if (parsed !== null) push(parsed);
      lineBuffer = '';
    }
    push(null); // done sentinel
  });

  try {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
      const item = queue.shift() as T | Error | null;
      if (item === null) {
        onClose?.(null);
        break;
      }
      if (item instanceof Error) throw item;
      yield item;
    }
  } finally {
    // Ensure we don't leak listeners
    stream.removeAllListeners('data');
    stream.removeAllListeners('error');
    stream.removeAllListeners('close');
  }
}
