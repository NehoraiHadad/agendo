# Message Delivery Pipeline

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/claudeRemote.ts (primary), with supporting primitives in `src/utils/PushableAsyncIterable.ts`, `src/utils/MessageQueue2.ts`, `src/claude/sdk/query.ts`, `src/claude/sdk/stream.ts`, and `src/claude/utils/OutgoingMessageQueue.ts`.

## What

Happy implements a three-stage message delivery pipeline that moves user messages from a remote server through an in-process mode-aware queue, into the Claude Code process stdin via an async iterable bridge. The stages are:

1. **MessageQueue2** -- a mode-aware inbound queue that receives user messages from the server (via websocket/RPC), batches consecutive messages with identical "enhanced mode" configuration (permission mode, model, system prompt, tools), and blocks the consumer when empty.
2. **PushableAsyncIterable** -- a single-consumer async iterable that bridges the gap between imperative "push" calls and Claude SDK's `AsyncIterable<SDKUserMessage>` prompt interface. It delivers messages to `streamToStdin`, which serializes each value as JSON and writes it to the child process's stdin.
3. **OutgoingMessageQueue** -- an outgoing queue (server-to-client direction) that maintains strict ordering of SDK messages being forwarded to the mobile app, with optional delay-and-release semantics for tool call messages.

This document focuses on stages 1 and 2 (the inbound path from user to Claude stdin), which are the most relevant to Agendo.

## Problem it solves

The core problem is that user messages arrive asynchronously (from a mobile app, web client, or server RPC) while the Claude process may or may not be running, and each message may carry different configuration (model, permission mode, system prompt, allowed tools). A naive approach of directly writing to stdin fails because:

1. **No process yet**: When the CLI starts, it needs a message to know *how* to configure the Claude process (which model, which permission mode). The message must be buffered until the consumer is ready.
2. **Mode changes require process restart**: If the user changes the model from Sonnet to Haiku mid-conversation, Happy must terminate the current Claude process and spawn a new one with updated SDK options. Messages with different modes cannot be batched together.
3. **Hot path vs cold path**: When Claude finishes a turn (emits `result`), the process stays alive waiting for more input via the `PushableAsyncIterable`. New messages must be delivered without respawning. But if the mode changed, the pending message must be held back and a new process spawned.
4. **Backpressure**: If no consumer is waiting (process not spawned yet), pushed values must be buffered in the queue without loss. When a consumer arrives, buffered values are drained immediately.

## How - Source Code

### Stage 1: MessageQueue2 -- Mode-Aware Inbound Queue

```typescript
// packages/happy-cli/src/utils/MessageQueue2.ts:1-14
interface QueueItem<T> {
    message: string;
    mode: T;
    modeHash: string;
    isolate?: boolean; // If true, this message must be processed alone
}

/**
 * A mode-aware message queue that stores messages with their modes.
 * Returns consistent batches of messages with the same mode.
 */
export class MessageQueue2<T> {
    public queue: QueueItem<T>[] = []; // Made public for testing
    private waiter: ((hasMessages: boolean) => void) | null = null;
    private closed = false;
```

The queue stores messages alongside their "enhanced mode" (a struct containing permissionMode, model, systemPrompt, allowedTools, etc). Each message is hashed by mode so that only consecutive messages with identical configuration are batched together.

The key consumer method is `waitForMessagesAndGetAsString()`:

```typescript
// packages/happy-cli/src/utils/MessageQueue2.ts:115-140
async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{
    message: string, mode: T, isolate: boolean, hash: string
} | null> {
    // If we have messages, return them immediately
    if (this.queue.length > 0) {
        return this.collectBatch();
    }

    // If closed or already aborted, return null
    if (this.closed || abortSignal?.aborted) {
        return null;
    }

    // Wait for messages to arrive
    const hasMessages = await this.waitForMessages(abortSignal);

    if (!hasMessages) {
        return null;
    }

    return this.collectBatch();
}
```

This uses a manual promise-based waiting mechanism (`this.waiter`) rather than an async iterable pattern. When a message is pushed, if there is a waiter, it is resolved immediately:

```typescript
// packages/happy-cli/src/utils/MessageQueue2.ts:37-58
push(message: string, mode: T): void {
    if (this.closed) {
        throw new Error('Cannot push to closed queue');
    }

    const modeHash = this.modeHasher(mode);
    this.queue.push({ message, mode, modeHash, isolate: false });

    // Trigger message handler if set
    if (this.onMessageHandler) {
        this.onMessageHandler(message, mode);
    }

    // Notify waiter if any
    if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter(true);
    }
}
```

The batch collector groups consecutive messages with the same mode hash, stopping at mode boundaries or isolated messages:

```typescript
// packages/happy-cli/src/utils/MessageQueue2.ts:145-181
private collectBatch(): { message: string, mode: T, hash: string, isolate: boolean } | null {
    if (this.queue.length === 0) { return null; }

    const firstItem = this.queue[0];
    const sameModeMessages: string[] = [];
    let mode = firstItem.mode;
    let isolate = firstItem.isolate ?? false;
    const targetModeHash = firstItem.modeHash;

    // If the first message requires isolation, only process it alone
    if (firstItem.isolate) {
        const item = this.queue.shift()!;
        sameModeMessages.push(item.message);
    } else {
        // Collect all messages with the same mode until we hit an isolated message
        while (this.queue.length > 0 &&
            this.queue[0].modeHash === targetModeHash &&
            !this.queue[0].isolate) {
            const item = this.queue.shift()!;
            sameModeMessages.push(item.message);
        }
    }

    const combinedMessage = sameModeMessages.join('\n');
    return { message: combinedMessage, mode, hash: targetModeHash, isolate };
}
```

Special commands like `/compact` and `/clear` use `pushIsolateAndClear()` which clears the queue and marks the message as isolated -- ensuring it is never batched with other messages and any stale pending messages are discarded:

```typescript
// packages/happy-cli/src/utils/MessageQueue2.ts:85-113
pushIsolateAndClear(message: string, mode: T): void {
    if (this.closed) {
        throw new Error('Cannot push to closed queue');
    }
    const modeHash = this.modeHasher(mode);
    // Clear any pending messages to ensure this message is processed in complete isolation
    this.queue = [];
    this.queue.push({ message, mode, modeHash, isolate: true });
    // Notify waiter if any
    if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter(true);
    }
}
```

### Stage 2: PushableAsyncIterable -- The Bridge to stdin

```typescript
// packages/happy-cli/src/utils/PushableAsyncIterable.ts:8-21
export class PushableAsyncIterable<T> implements AsyncIterableIterator<T> {
    private queue: T[] = []
    private waiters: Array<{
        resolve: (value: IteratorResult<T>) => void
        reject: (error: Error) => void
    }> = []
    private isDone = false
    private error: Error | null = null
    private started = false
```

This is a standard "pushable channel" pattern: it implements `AsyncIterableIterator<T>`, allowing it to be consumed with `for await...of`. Values can be pushed externally via `push()`. The key method:

```typescript
// packages/happy-cli/src/utils/PushableAsyncIterable.ts:28-42
push(value: T): void {
    if (this.isDone) {
        throw new Error('Cannot push to completed iterable')
    }
    if (this.error) {
        throw this.error
    }

    // If there's a waiting consumer, deliver directly
    const waiter = this.waiters.shift()
    if (waiter) {
        waiter.resolve({ done: false, value })
    } else {
        // Otherwise queue the value
        this.queue.push(value)
    }
}
```

This implements **direct delivery** when a consumer is already waiting (the `for await` loop is suspended at `next()`), and **buffering** when no consumer is ready. The `next()` method mirrors this:

```typescript
// packages/happy-cli/src/utils/PushableAsyncIterable.ts:79-95
async next(): Promise<IteratorResult<T>> {
    // Return queued items first
    if (this.queue.length > 0) {
        return { done: false, value: this.queue.shift()! }
    }

    // Check if we're done or have an error
    if (this.isDone) {
        if (this.error) { throw this.error }
        return { done: true, value: undefined }
    }

    // Wait for next value
    return new Promise<IteratorResult<T>>((resolve, reject) => {
        this.waiters.push({ resolve, reject })
    })
}
```

The iterable enforces single-consumer semantics:

```typescript
// packages/happy-cli/src/utils/PushableAsyncIterable.ts:110-116
[Symbol.asyncIterator](): AsyncIterableIterator<T> {
    if (this.started) {
        throw new Error('PushableAsyncIterable can only be iterated once')
    }
    this.started = true
    return this
}
```

### Wiring: claudeRemote.ts connects the two stages

In `claudeRemote.ts`, the pipeline is wired together:

```typescript
// packages/happy-cli/src/claude/claudeRemote.ts:105-112
// Push initial message
let messages = new PushableAsyncIterable<SDKUserMessage>();
messages.push({
    type: 'user',
    message: {
        role: 'user',
        content: initial.message,
    },
});

// Start the loop
const response = query({
    prompt: messages,
    options: sdkOptions,
});
```

The `PushableAsyncIterable` is passed as the `prompt` to the Claude SDK's `query()` function. Inside `query()`, the iterable is consumed by `streamToStdin()`:

```typescript
// packages/happy-cli/src/claude/sdk/utils.ts:113-121
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

When Claude finishes a turn (emits `result`), the response handler pushes the next message from the MessageQueue2 into the PushableAsyncIterable:

```typescript
// packages/happy-cli/src/claude/claudeRemote.ts:132-148
// Handle result messages
if (message.type === 'result') {
    updateThinking(false);

    // Send ready event
    opts.onReady();

    // Push next message
    const next = await opts.nextMessage();
    if (!next) {
        messages.end();
        return;
    }
    mode = next.mode;
    messages.push({ type: 'user', message: { role: 'user', content: next.message } });
}
```

The `opts.nextMessage()` is provided by `claudeRemoteLauncher.ts`, which calls `session.queue.waitForMessagesAndGetAsString()`. If the next message has a different mode hash, it is held as `pending` and `null` is returned, causing the current Claude process to shut down. The outer loop in `claudeRemoteLauncher` then spawns a new process with the updated configuration:

```typescript
// packages/happy-cli/src/claude/claudeRemoteLauncher.ts (nextMessage callback):228-248
nextMessage: async () => {
    if (pending) {
        let p = pending;
        pending = null;
        permissionHandler.handleModeChange(p.mode.permissionMode);
        return p;
    }

    let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

    // Check if mode has changed
    if (msg) {
        if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
            pending = msg;
            return null;  // Signal to terminate current process
        }
        modeHash = msg.hash;
        mode = msg.mode;
        permissionHandler.handleModeChange(mode.permissionMode);
        return { message: msg.message, mode: msg.mode }
    }

    return null;  // Queue closed or aborted
},
```

### The Local Mode Shortcut

In local mode (`claudeLocalLauncher.ts`), the message pipeline is bypassed entirely. The Claude process inherits the terminal's stdin/stdout directly (`stdio: ['inherit', 'inherit', 'inherit', 'pipe']`). Messages typed at the keyboard go straight to Claude's interactive input. When a remote message arrives, the local launcher aborts and switches to remote mode:

```typescript
// packages/happy-cli/src/claude/claudeLocalLauncher.ts:53-56
session.queue.setOnMessage((message: string, mode) => {
    // Switch to remote mode when message received
    doSwitch();
}); // When any message is received, abort current process, clean queue and switch to remote mode
```

### Stage 3: OutgoingMessageQueue (server-to-client, for reference)

The `OutgoingMessageQueue` handles the reverse direction: SDK messages from Claude back to the client. It maintains strict ordering via incremental IDs, with optional delay for tool_use messages (250ms) that can be released early when the tool result arrives. This prevents a visual flicker where a tool_use appears briefly before its result.

```typescript
// packages/happy-cli/src/claude/utils/OutgoingMessageQueue.ts:38-65
enqueue(logMessage: any, options?: {
    delay?: number,
    toolCallIds?: string[]
}) {
    this.lock.inLock(async () => {
        const item: QueueItem = {
            id: this.nextId++,
            logMessage,
            delayed: !!options?.delay,
            delayMs: options?.delay || 0,
            toolCallIds: options?.toolCallIds,
            released: !options?.delay,
            sent: false
        };
        this.queue.push(item);
        if (item.delayed) {
            const timer = setTimeout(() => {
                this.releaseItem(item.id);
            }, item.delayMs);
            this.delayTimers.set(item.id, timer);
        }
    });
    this.scheduleProcessing();
}
```

## Relevance to Agendo

- **What Agendo already does**: Agendo has a simpler pipeline: `PG NOTIFY control message -> SessionProcess.onControl() -> SessionProcess.pushMessage() -> ClaudeAdapter.sendMessage() -> stdin.write()`. This is a direct "fire and write" approach with no buffering, no mode awareness, and no backpressure. The cold-resume path creates a new execution with `promptOverride` and `--resume sessionRef`, re-spawning the process. There is no equivalent to MessageQueue2 or PushableAsyncIterable -- messages are written directly to stdin via `this.childProcess.stdin.write(ndjsonMessage + '\n')`.

- **Gap this fills**: Agendo lacks three capabilities that Happy's pipeline provides:
  1. **Mode-aware batching**: Agendo has no concept of per-message configuration (model, permission mode, system prompt). If Agendo ever supports changing models or permission modes mid-session, it would need something like MessageQueue2 to detect mode changes and trigger process restarts.
  2. **Backpressure / buffering for cold-resume**: When an Agendo session is idle (process killed after idle timeout), the next message triggers a cold-resume that re-spawns the process. If multiple messages arrive during this window, they could race. Happy's MessageQueue2 + PushableAsyncIterable cleanly handles this: messages are buffered in the queue, and the PushableAsyncIterable feeds them one-at-a-time to the stdin consumer.
  3. **Graceful process lifecycle transitions**: Happy's `nextMessage()` callback pattern elegantly handles the turn boundary -- Claude emits `result`, the handler awaits the next message from the queue, and either delivers it (hot path) or signals process termination (mode change). Agendo's `awaiting_input -> active` transition is simpler but doesn't handle configuration changes.

- **Recommendation**: **Adapt** -- Agendo should adopt a simplified version of this pipeline:
  1. **PushableAsyncIterable**: Adopt as-is. This is a clean, well-tested primitive (~120 lines) that replaces Agendo's current pattern of writing directly to stdin. It would let Agendo use Claude SDK's `AsyncIterable` prompt interface instead of raw stdin writes, enabling features like proper stream-json input and backpressure.
  2. **MessageQueue2**: Adopt if/when Agendo adds per-message model or permission configuration. For now, a simpler single-mode queue would suffice. The key design insight to adopt is the `waitForMessagesAndGetAsString()` pattern -- suspending the consumer when the queue is empty, and waking it when a message arrives via PG NOTIFY.
  3. **OutgoingMessageQueue**: Skip -- Agendo already streams events to the browser via SSE + PG NOTIFY and doesn't need the tool-call delay/release optimization (the browser can handle tool_use appearing before tool_result).
