# Utility Patterns

Research from [Happy Coder](https://github.com/slopus/happy) repository (slopus/happy).

---

## Future

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/utils/future.ts

### What

A minimal promise wrapper that externalizes `resolve` and `reject` callbacks, allowing a promise to be settled from outside its constructor. This is the classic "deferred" pattern, providing a clean API for cases where the code that creates the promise is different from the code that resolves it.

### How - Source Code

```typescript
// packages/happy-cli/src/utils/future.ts:1-22
export class Future<T> {
    private _resolve!: (value: T) => void;
    private _reject!: (reason?: any) => void;
    private _promise: Promise<T>;

    constructor() {
        this._promise = new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    resolve(value: T) {
        this._resolve(value);
    }

    reject(reason?: any) {
        this._reject(reason);
    }

    get promise() {
        return this._promise;
    }
}
```

### Relevance to Agendo

- **Recommendation**: **Adopt** -- Agendo's `session-process.ts` currently uses manual Promise constructor patterns to coordinate between process lifecycle events and callers waiting on results. A `Future<T>` would simplify these patterns significantly. For example, when the session process starts and the caller needs to wait for the first output line (confirming the process is alive), a Future provides a cleaner API than constructing ad-hoc promises. It would also be useful in the SSE event delivery path and anywhere stdin writes need to wait for acknowledgement.

---

## InvalidateSync

Source: https://github.com/slopus/happy/blob/main/packages/happy-app/sources/utils/sync.ts (also at `packages/happy-cli/src/utils/sync.ts` -- same implementation)

### What

A coalescing async operation runner. When `invalidate()` is called multiple times rapidly, only one execution of the underlying command runs at a time. If additional invalidations arrive during execution, exactly one more execution is queued (not N). This prevents thundering-herd problems on expensive async operations (e.g., flushing state to a database). Also includes `invalidateAndAwait()` which lets the caller wait for the current/next cycle to complete.

The file also exports `ValueSync<T>`, a variant that passes the most recent value to the command, always processing only the latest value (dropping intermediate values).

### How - Source Code

```typescript
// packages/happy-app/sources/utils/sync.ts:1-68 (InvalidateSync only)
import { backoff } from "@/utils/time";

export class InvalidateSync {
    private _invalidated = false;
    private _invalidatedDouble = false;
    private _stopped = false;
    private _command: () => Promise<void>;
    private _pendings: (() => void)[] = [];

    constructor(command: () => Promise<void>) {
        this._command = command;
    }

    invalidate() {
        if (this._stopped) {
            return;
        }
        if (!this._invalidated) {
            this._invalidated = true;
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            if (!this._invalidatedDouble) {
                this._invalidatedDouble = true;
            }
        }
    }

    async invalidateAndAwait() {
        if (this._stopped) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
            this.invalidate();
        });
    }

    async awaitQueue() {
        if (this._stopped || (!this._invalidated && this._pendings.length === 0)) {
            return;
        }
        await new Promise<void>(resolve => {
            this._pendings.push(resolve);
        });
    }

    stop() {
        if (this._stopped) {
            return;
        }
        this._notifyPendings();
        this._stopped = true;
    }

    private _notifyPendings = () => {
        for (let pending of this._pendings) {
            pending();
        }
        this._pendings = [];
    }

    private _doSync = async () => {
        await backoff(async () => {
            if (this._stopped) {
                return;
            }
            await this._command();
        });
        if (this._stopped) {
            this._notifyPendings();
            return;
        }
        if (this._invalidatedDouble) {
            this._invalidatedDouble = false;
            this._doSync();
        } else {
            this._invalidated = false;
            this._notifyPendings();
        }
    }
}
```

The companion `backoff` function used by `_doSync`:

```typescript
// packages/happy-cli/src/utils/time.ts (relevant excerpt)
export async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function exponentialBackoffDelay(currentFailureCount: number, minDelay: number, maxDelay: number, maxFailureCount: number) {
    let maxDelayRet = minDelay + ((maxDelay - minDelay) / maxFailureCount) * Math.min(currentFailureCount, maxFailureCount);
    return Math.round(Math.random() * maxDelayRet);
}

export type BackoffFunc = <T>(callback: () => Promise<T>) => Promise<T>;

export function createBackoff(
    opts?: {
        onError?: (e: any, failuresCount: number) => void,
        minDelay?: number,
        maxDelay?: number,
        maxFailureCount?: number
    }): BackoffFunc {
    return async <T>(callback: () => Promise<T>): Promise<T> => {
        let currentFailureCount = 0;
        const minDelay = opts && opts.minDelay !== undefined ? opts.minDelay : 250;
        const maxDelay = opts && opts.maxDelay !== undefined ? opts.maxDelay : 1000;
        const maxFailureCount = opts && opts.maxFailureCount !== undefined ? opts.maxFailureCount : 50;
        while (true) {
            try {
                return await callback();
            } catch (e) {
                if (currentFailureCount < maxFailureCount) {
                    currentFailureCount++;
                }
                if (opts && opts.onError) {
                    opts.onError(e, currentFailureCount);
                }
                let waitForRequest = exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
                await delay(waitForRequest);
            }
        }
    };
}

export let backoff = createBackoff();
```

### Relevance to Agendo

- **Recommendation**: **Adapt** -- Agendo could use this pattern for coalescing SSE event broadcasts and database status updates. Currently, when multiple execution events arrive in quick succession (e.g., rapid tool calls), each triggers an independent PG NOTIFY and database update. An `InvalidateSync`-style coalescer could batch these into a single DB write + single notification. However, Agendo should strip the `backoff` dependency for non-network operations and use a simpler retry strategy, since the auto-retry-on-failure behavior is overkill for local state flushes.

---

## Atomic File Writes

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/utils/fileAtomic.ts

### What

A simple atomic file write utility using the classic "write to temp file, then rename" pattern. This ensures that readers never see a partially-written file -- the rename operation is atomic on POSIX filesystems.

### How - Source Code

```typescript
// packages/happy-cli/src/utils/fileAtomic.ts:1-22
/**
 * Atomic file write utility
 * Ensures file writes are atomic using temp file + rename pattern
 */

import { writeFile, rename, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';

export async function atomicFileWrite(filePath: string, content: string): Promise<void> {
  const tmpFile = `${filePath}.${randomUUID()}.tmp`;

  try {
    // Write to temp file
    await writeFile(tmpFile, content);

    // Atomic rename (on POSIX systems)
    await rename(tmpFile, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await unlink(tmpFile);
    } catch {}
    throw error;
  }
}
```

### Relevance to Agendo

- **Recommendation**: **Skip** -- Agendo does not write critical configuration or state files that would benefit from atomic writes. All persistent state is stored in PostgreSQL. The only file writes are log files (append-only, no atomicity needed) and the worker's compiled JS output (build-time, not runtime). If Agendo later adds file-based session state persistence, this pattern would be worth revisiting.

---

## Process Health Check (kill pid 0)

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/daemon/run.ts

### What

Uses `process.kill(pid, 0)` to check whether a process is still alive without actually sending it a signal. Signal 0 is a POSIX standard: if the call succeeds, the process exists; if it throws `ESRCH`, the process is dead. This is used in a periodic heartbeat loop (every 60 seconds by default) to prune stale sessions from the daemon's tracking map.

### How - Source Code

```typescript
// packages/happy-cli/src/daemon/run.ts (heartbeat interval handler)
const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
let heartbeatRunning = false
const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
  if (heartbeatRunning) {
    return;
  }
  heartbeatRunning = true;

  if (process.env.DEBUG) {
    logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
  }

  // Prune stale sessions
  for (const [pid, _] of pidToTrackedSession.entries()) {
    try {
      // Check if process is still alive (signal 0 doesn't kill, just checks)
      process.kill(pid, 0);
    } catch (error) {
      // Process is dead, remove from tracking
      logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
      pidToTrackedSession.delete(pid);
    }
  }
```

### Relevance to Agendo

- **Recommendation**: **Adopt** -- This is directly applicable to Agendo's `session-process.ts`. Currently, Agendo tracks running Claude CLI processes but has no periodic health check to detect when a process has died unexpectedly (e.g., OOM kill, segfault, or Claude CLI crash). If the process dies without emitting an exit event (which can happen if the child is a grandchild of the spawned process), the session remains stuck in `running` state forever. Adding a `process.kill(pid, 0)` check on a timer (e.g., every 30 seconds) would let the worker detect dead sessions and update their status to `failed`. Implementation is trivial -- roughly 10 lines of code in the worker's session tracking logic.

---

## Stdin Backpressure

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/sdk/utils.ts and `query.ts`

### What

Happy Coder does **NOT** implement stdin backpressure handling. The `streamToStdin` utility and all `stdin.write()` calls are fire-and-forget -- they do not check the return value of `write()` (which returns `false` when the kernel buffer is full) or listen for the `drain` event.

### How - Source Code

```typescript
// packages/happy-cli/src/claude/sdk/utils.ts (streamToStdin function)
/**
 * Stream async messages to stdin
 */
export async function streamToStdin(
    stream: AsyncIterable<unknown>,
    stdin: NodeJS.WritableStream,
    abort?: AbortSignal
): Promise<void> {
    for await (const message of stream) {
        if (abort?.aborted) break
        stdin.write(JSON.stringify(message) + '\n')
    }
    stdin.end()
}
```

```typescript
// packages/happy-cli/src/claude/sdk/query.ts (control request writes, excerpt)
childStdin.write(JSON.stringify(sdkRequest) + '\n')
// ...
this.childStdin.write(JSON.stringify(controlResponse) + '\n')
```

In all cases, `stdin.write()` is called without checking the boolean return value. No `drain` event listener exists anywhere in the codebase.

### Relevance to Agendo

- **Recommendation**: **Adapt (implement what Happy does NOT)** -- Agendo should add backpressure handling where Happy Coder omitted it. In Agendo's `session-process.ts`, when sending messages to the Claude CLI's stdin, the write call should check the return value. If `write()` returns `false`, the caller should pause and wait for the `drain` event before sending the next message. This is especially important for Agendo because it sends potentially large prompts (user messages with context) and the Claude CLI process may be slow to consume stdin if it is busy processing. A simple implementation:

```typescript
async function writeWithBackpressure(
  stream: NodeJS.WritableStream,
  data: string
): Promise<void> {
  const canContinue = stream.write(data);
  if (!canContinue) {
    await new Promise<void>(resolve => stream.once('drain', resolve));
  }
}
```

This is a gap in Happy Coder that Agendo should fill.

---

## Bonus: Additional Utility Patterns Found

### AsyncLock

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/utils/lock.ts

A mutex/semaphore for serializing async operations. Uses a permit-based system with a queue of waiting resolvers.

```typescript
// packages/happy-cli/src/utils/lock.ts:1-30
export class AsyncLock {
    private permits: number = 1;
    private promiseResolverQueue: Array<(v: boolean) => void> = [];

    async inLock<T>(func: () => Promise<T> | T): Promise<T> {
        try {
            await this.lock();
            return await func();
        } finally {
            this.unlock();
        }
    }

    private async lock() {
        if (this.permits > 0) {
            this.permits = this.permits - 1;
            return;
        }
        await new Promise<boolean>(resolve => this.promiseResolverQueue.push(resolve));
    }

    private unlock() {
        this.permits += 1;
        if (this.permits > 1 && this.promiseResolverQueue.length > 0) {
            throw new Error('this.permits should never be > 0 when there is someone waiting.');
        } else if (this.permits === 1 && this.promiseResolverQueue.length > 0) {
            this.permits -= 1;
            const nextResolver = this.promiseResolverQueue.shift();
            if (nextResolver) {
                setTimeout(() => {
                    nextResolver(true);
                }, 0);
            }
        }
    }
}
```

- **Recommendation**: **Adapt** -- Useful for serializing stdin writes in `session-process.ts` to prevent interleaving when multiple messages arrive simultaneously. Agendo already has some serialization via pg-boss job ordering, but within-session stdin access is unguarded.

### PushableAsyncIterable

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/utils/PushableAsyncIterable.ts

A producer-consumer async iterable that allows external `push()` with direct delivery to waiting consumers or queue buffering. Single-iteration enforced. Used for bridging event-driven APIs to `for await...of` consumption.

```typescript
// packages/happy-cli/src/utils/PushableAsyncIterable.ts:1-24 (constructor + push)
export class PushableAsyncIterable<T> implements AsyncIterableIterator<T> {
    private queue: T[] = []
    private waiters: Array<{
        resolve: (value: IteratorResult<T>) => void
        reject: (error: Error) => void
    }> = []
    private isDone = false
    private error: Error | null = null
    private started = false

    push(value: T): void {
        if (this.isDone) {
            throw new Error('Cannot push to completed iterable')
        }
        if (this.error) {
            throw this.error
        }
        const waiter = this.waiters.shift()
        if (waiter) {
            waiter.resolve({ done: false, value })
        } else {
            this.queue.push(value)
        }
    }
    // ... end(), setError(), next(), return(), throw(), [Symbol.asyncIterator]()
}
```

- **Recommendation**: **Skip** -- Agendo uses SSE + PG LISTEN/NOTIFY for event streaming rather than async iterables. The pattern is elegant but does not fit Agendo's architecture.
