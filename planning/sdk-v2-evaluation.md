# SDK V2 API Evaluation

## Overview

The Claude Agent SDK exports three `unstable_v2_*` functions that offer a different session management pattern compared to the current V1 `query()` API. This document evaluates whether Agendo should plan for migration.

## Current V1 Pattern (What We Use)

```typescript
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

// Create an AsyncQueue that feeds messages to the SDK
const inputQueue = new AsyncQueue<SDKUserMessage>();

// Push initial message
inputQueue.push({ type: 'user', message: { role: 'user', content: prompt }, ... });

// Create the query — SDK iterates over the async input queue
const q = query({
  prompt: inputQueue as AsyncIterable<SDKUserMessage>,
  options: sdkOptions,
});

// Consume messages
for await (const msg of q) {
  // Process SDKMessage
}

// Multi-turn: push more messages into inputQueue
inputQueue.push({ type: 'user', message: { role: 'user', content: followUp }, ... });
```

**Key characteristics**:

- Single `query()` call with an `AsyncIterable<SDKUserMessage>` prompt
- Multi-turn via the async iterable pattern (our `AsyncQueue`)
- Messages and control (permissions, interrupts) on the `Query` object
- Query is both the input mechanism and the output iterator
- Resume via `options.resume` field

## V2 Pattern

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  unstable_v2_prompt,
} from '@anthropic-ai/claude-agent-sdk';

// Create a session object
const session = unstable_v2_createSession({ model: 'claude-sonnet-4-6', ... });

// Send a message
await session.send(message);

// Stream responses
for await (const msg of session.stream()) {
  // Process SDKMessage
}

// Multi-turn: just send() again and stream() again
await session.send(followUpMessage);
for await (const msg of session.stream()) { ... }

// Resume existing session
const resumed = unstable_v2_resumeSession(sessionId, options);

// One-shot convenience
const result = await unstable_v2_prompt("question", options);

// Cleanup
session.close();
// or: await using session = unstable_v2_createSession(...)  // auto-dispose
```

### SDKSession Interface

```typescript
interface SDKSession {
  readonly sessionId: string; // Available after first message
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>; // await using support
}
```

### SDKSessionOptions (V2)

```typescript
type SDKSessionOptions = {
  model: string; // Required (not optional like V1)
  pathToClaudeCodeExecutable?: string;
  executable?: 'node' | 'bun';
  executableArgs?: string[];
  env?: Record<string, string | undefined>;
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  permissionMode?: PermissionMode;
};
```

## Key Differences

| Aspect               | V1 (`query()`)                     | V2 (`createSession()`)                    |
| -------------------- | ---------------------------------- | ----------------------------------------- |
| **Session object**   | `Query` (iterator + control)       | `SDKSession` (send/stream)                |
| **Multi-turn**       | Push to AsyncIterable              | `send()` then `stream()`                  |
| **Input mechanism**  | AsyncIterable prompt               | Explicit `send()` calls                   |
| **Output mechanism** | `for await (msg of query)`         | `for await (msg of session.stream())`     |
| **Resume**           | `options.resume` field             | `unstable_v2_resumeSession()`             |
| **One-shot**         | N/A                                | `unstable_v2_prompt()`                    |
| **Disposal**         | `query.close()`                    | `session.close()` + `Symbol.asyncDispose` |
| **Options surface**  | Full `Options` type (50+ fields)   | Reduced `SDKSessionOptions` (~10 fields)  |
| **Control methods**  | On Query (setPermissionMode, etc.) | Not exposed on SDKSession                 |
| **Stability**        | Stable                             | `@alpha`, `unstable_` prefix              |

## What V2 Adds Over V1

1. **Clearer multi-turn semantics** — `send()` / `stream()` is more intuitive than the AsyncQueue pattern
2. **Explicit session lifecycle** — `createSession` / `resumeSession` / `close` makes lifecycle obvious
3. **AsyncDisposable** — `await using` support for automatic cleanup
4. **One-shot convenience** — `unstable_v2_prompt()` for fire-and-forget single prompts
5. **Separate resume function** — `unstable_v2_resumeSession()` instead of options field

## What V2 Currently Lacks vs V1

1. **Reduced Options surface** — `SDKSessionOptions` has ~10 fields vs V1's 50+. Missing: `agents`, `mcpServers`, `systemPrompt`, `maxBudgetUsd`, `effort`, `persistSession`, `sessionId`, `forkSession`, `resume`, `extraArgs`, `outputFormat`, `enableFileCheckpointing`, etc.
2. **No control methods** — `SDKSession` has `send`/`stream`/`close` only. No `setPermissionMode()`, `setModel()`, `mcpServerStatus()`, `interrupt()`, `rewindFiles()`.
3. **Missing features we depend on** — No MCP server config, no system prompt, no budget control, no effort setting, no session ID forcing.

## Stability Assessment

- All three functions have `unstable_v2_` prefix and `@alpha` JSDoc tag
- The `SDKSessionOptions` type is much smaller than `Options`, suggesting the API surface is still being designed
- No migration guide or deprecation notice for V1
- V1 `query()` has no deprecation warnings

## Impact on claude-sdk-adapter.ts

If V2 stabilizes with full feature parity, the migration would affect:

1. **`_start()` method** — Replace `query()` + `AsyncQueue` with `createSession()` + `send()`
2. **`runQueryLoop()`** — Replace single `for await` with per-turn `stream()` calls
3. **`sendMessage()`** — Replace `inputQueue.push()` with `session.send()`
4. **`resume()`** — Use `unstable_v2_resumeSession()` instead of `options.resume`
5. **Control methods** — `setPermissionMode()`, `setModel()`, `getMcpStatus()` would need V2 equivalents
6. **`interrupt()`** — No V2 equivalent currently

The `AsyncQueue` class (40 lines) could be removed entirely.

### Estimated migration effort

If V2 reaches feature parity: ~2-4 hours of adapter refactoring. The event mapper (`sdk-event-mapper.ts`) and `SessionDataPipeline` would remain unchanged since they operate on `SDKMessage` objects regardless of how they're produced.

## Recommendation

**Do NOT migrate to V2 now.** Wait for these triggers:

1. **Feature parity** — `SDKSessionOptions` must support all fields we use from `Options` (MCP servers, system prompt, agents, hooks, budget, effort, session ID, etc.)
2. **Control methods** — `SDKSession` must expose `setPermissionMode()`, `setModel()`, `interrupt()`, `mcpServerStatus()`
3. **Stability announcement** — The `unstable_` prefix and `@alpha` tag are removed
4. **V1 deprecation** — Anthropic signals that `query()` will be deprecated

**Rationale**: V2's `send()`/`stream()` pattern is cleaner than our AsyncQueue, but the API surface is too limited for our needs. We use ~15 Options fields that V2 doesn't support. The migration cost is low once V2 is ready, so there's no benefit to early adoption.

**Action items**:

- Monitor SDK changelogs for V2 updates
- When V2 reaches beta (prefix removed), re-evaluate this document
- Consider using `unstable_v2_prompt()` for one-shot execution sessions (kind='execution') as a trial, since those need fewer options
