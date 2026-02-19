# Thinking State Detection

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/scripts/claude_local_launcher.cjs

## What

Happy Coder detects when Claude is actively "thinking" (making API calls to the Anthropic backend) by monkey-patching `global.fetch` inside a Node.js launcher script that runs in the same process as Claude Code's CLI. A CJS wrapper script (`claude_local_launcher.cjs`) intercepts every `fetch()` call, writes structured JSON events to file descriptor 3 (fd3), and the parent process reads these events to track active API requests. When at least one fetch is in-flight, the session is in the "thinking" state; when all fetches complete, it transitions back to "waiting" after a 500ms debounce.

## Problem it solves

Claude Code CLI is a black box from the perspective of a wrapper process. It spawns as an interactive terminal application and does not emit structured "I'm making an API call now" events. The NDJSON output stream only contains *completed* responses (assistant messages, tool uses, tool results), not the in-progress state of API calls being made. This means a naive wrapper can only detect that Claude is "running" (process alive) vs "exited" -- it cannot distinguish between "Claude is waiting for user input" and "Claude is actively calling the Anthropic API and generating a response."

Attempting to detect thinking from NDJSON events alone is unreliable because: (1) there's no "API call started" event in the standard output, (2) tool executions can take variable time creating ambiguity, and (3) the gap between receiving the last token and the next API call is indistinguishable from the gap when Claude is idle and waiting for input.

## How - Source Code

### Layer 1: The fetch monkey-patch shim

```javascript
// packages/happy-cli/scripts/claude_local_launcher.cjs:1-48
const fs = require('fs');

// Disable autoupdater (never works really)
process.env.DISABLE_AUTOUPDATER = '1';

// Helper to write JSON messages to fd 3
function writeMessage(message) {
    try {
        fs.writeSync(3, JSON.stringify(message) + '\n');
    } catch (err) {
        // fd 3 not available, ignore
    }
}

// Intercept fetch to track thinking state
const originalFetch = global.fetch;
let fetchCounter = 0;

global.fetch = function(...args) {
    const id = ++fetchCounter;
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    const method = args[1]?.method || 'GET';

    // Parse URL for privacy
    let hostname = '';
    let path = '';
    try {
        const urlObj = new URL(url, 'http://localhost');
        hostname = urlObj.hostname;
        path = urlObj.pathname;
    } catch (e) {
        hostname = 'unknown';
        path = url;
    }

    // Send fetch start event
    writeMessage({
        type: 'fetch-start',
        id,
        hostname,
        path,
        method,
        timestamp: Date.now()
    });

    // Execute the original fetch immediately
    const fetchPromise = originalFetch(...args);

    // Attach handlers to send fetch end event
    const sendEnd = () => {
        writeMessage({
            type: 'fetch-end',
            id,
            timestamp: Date.now()
        });
    };

    // Send end event on both success and failure
    fetchPromise.then(sendEnd, sendEnd);

    // Return the original promise unchanged
    return fetchPromise;
};
```

This CJS script is loaded *before* Claude Code's CLI entry point. Because it runs in the same Node.js process, `global.fetch` is shared. The monkey-patch wraps every fetch call with start/end events written to fd3 as newline-delimited JSON. The `id` counter ensures each fetch can be correlated across start/end events.

Key design decisions:
- **fd3** (not stdout/stderr) avoids interfering with Claude's terminal UI or NDJSON output
- **Privacy-aware**: only hostname and pathname are sent, not query params or request bodies
- **Non-blocking**: `fs.writeSync(3, ...)` is synchronous but writing to a pipe is fast; the original fetch promise is returned unchanged
- **Correlation IDs**: monotonically increasing `id` field lets the consumer track multiple concurrent fetches

The shim then loads Claude Code's actual CLI:

```javascript
// packages/happy-cli/scripts/claude_local_launcher.cjs:55-67
const { getClaudeCliPath, runClaudeCli } = require('./claude_version_utils.cjs');
runClaudeCli(getClaudeCliPath());
```

Important: `runClaudeCli()` checks if the resolved path is a `.js` file. If so, it uses dynamic `import()` which keeps the monkey-patched `global.fetch` in scope. If it's a binary (e.g., from Homebrew), it spawns a child process where the shim has no effect.

```javascript
// packages/happy-cli/scripts/claude_version_utils.cjs:315-329
function runClaudeCli(cliPath) {
    const { pathToFileURL } = require('url');
    const { spawn } = require('child_process');

    const isJsFile = cliPath.endsWith('.js') || cliPath.endsWith('.cjs');
    if (isJsFile) {
        // JavaScript file - use import to keep interceptors working
        const importUrl = pathToFileURL(cliPath).href;
        import(importUrl);
    } else {
        // Binary file - spawn directly (interceptors won't work)
        const args = process.argv.slice(2);
        const child = spawn(cliPath, args, { stdio: 'inherit', env: process.env });
        child.on('exit', (code) => process.exit(code || 0));
    }
}
```

### Layer 2: Parent process reads fd3 pipe

The parent process spawns the launcher with `stdio: ['inherit', 'inherit', 'inherit', 'pipe']`, creating a readable pipe on the 4th stdio slot (fd3 from the child's perspective):

```typescript
// packages/happy-cli/src/claude/claudeLocal.ts:184-195
const child = spawn(
    spawnWithShell && spawnCommand ? spawnCommand : 'node',
    spawnWithShell ? [] : spawnArgs,
    {
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
        signal: opts.abort,
        cwd: opts.path,
        env,
        shell: spawnWithShell,
    },
);
```

Then it reads the fd3 pipe using `readline` and maintains a `Map` of active fetches:

```typescript
// packages/happy-cli/src/claude/claudeLocal.ts:198-252
if (child.stdio[3]) {
    const rl = createInterface({
        input: child.stdio[3] as any,
        crlfDelay: Infinity
    });

    // Track active fetches for thinking state
    const activeFetches = new Map<number, { hostname: string, path: string, startTime: number }>();

    rl.on('line', (line) => {
        try {
            const message = JSON.parse(line);

            switch (message.type) {
                case 'fetch-start':
                    activeFetches.set(message.id, {
                        hostname: message.hostname,
                        path: message.path,
                        startTime: message.timestamp
                    });

                    // Clear any pending stop timeout
                    if (stopThinkingTimeout) {
                        clearTimeout(stopThinkingTimeout);
                        stopThinkingTimeout = null;
                    }

                    // Start thinking
                    updateThinking(true);
                    break;

                case 'fetch-end':
                    activeFetches.delete(message.id);

                    // Stop thinking when no active fetches
                    if (activeFetches.size === 0 && thinking && !stopThinkingTimeout) {
                        stopThinkingTimeout = setTimeout(() => {
                            if (activeFetches.size === 0) {
                                updateThinking(false);
                            }
                            stopThinkingTimeout = null;
                        }, 500); // Small delay to avoid flickering
                    }
                    break;
            }
        } catch (e) {
            // Not JSON, ignore
        }
    });
}
```

The 500ms debounce on `fetch-end` is critical: Claude often makes multiple sequential API calls (e.g., thinking completion followed by tool execution), and without the debounce, the thinking indicator would flicker on/off between calls.

### Layer 3: Propagation to server and clients

The `updateThinking()` callback flows through three layers:

1. **claudeLocal.ts** calls `opts.onThinkingChange(thinking)` when thinking state changes
2. **Session class** (`session.ts:82-85`) updates its `thinking` property and calls `keepAlive`:

```typescript
// packages/happy-cli/src/claude/session.ts:82-85
onThinkingChange = (thinking: boolean) => {
    this.thinking = thinking;
    this.client.keepAlive(thinking, this.mode);
}
```

3. **ApiSessionClient** sends the state to the server via a volatile Socket.IO emit every 2 seconds (keepAlive interval) and immediately on state change:

```typescript
// packages/happy-cli/src/api/apiSession.ts:475-487
keepAlive(thinking: boolean, mode: 'local' | 'remote') {
    this.socket.volatile.emit('session-alive', {
        sid: this.sessionId,
        time: Date.now(),
        thinking,
        mode
    });
}
```

4. **Server** (`sessionUpdateHandler.ts:129-166`) receives the `session-alive` event and broadcasts an ephemeral `activity` event to all connected clients of the same user:

```typescript
// packages/happy-server/sources/app/events/eventRouter.ts:485-493
export function buildSessionActivityEphemeral(
    sessionId: string, active: boolean, activeAt: number, thinking?: boolean
): EphemeralPayload {
    return {
        type: 'activity',
        id: sessionId,
        active,
        activeAt,
        thinking: thinking || false
    };
}
```

5. **Mobile app** renders it as a "vibing" status (with randomized messages like "cooking...", "brewing ideas...") with a pulsing blue dot:

```typescript
// packages/happy-app/sources/utils/sessionUtils.ts:5-64
export type SessionState = 'disconnected' | 'thinking' | 'waiting' | 'permission_required';

// ...
if (session.thinking === true) {
    return {
        state: 'thinking',
        isConnected: true,
        statusText: vibingMessage,
        statusColor: '#007AFF',
        statusDotColor: '#007AFF',
        isPulsing: true
    };
}
```

## Relevance to Agendo

- **What Agendo already does**: Agendo has an `agent:thinking` event type in its event schema (`src/lib/realtime/events.ts:17`), and `session-process.ts` extracts `thinking` blocks from Claude's NDJSON output (lines 212-222, 253-255). However, this is *Claude's extended thinking content* (the actual reasoning text), NOT the "is Claude currently making an API call" detection that Happy implements. Agendo's execution status tracks `running` vs `idle` at a coarse level (session status in the database), but does not have fine-grained "thinking" state that distinguishes "Claude is actively calling the API" from "Claude is waiting for input." The session status in Agendo is `active` (process alive) or `idle` (awaiting input), with no intermediate state for "actively streaming from API."

- **Gap this fills**: Without fd3-based thinking detection, Agendo cannot show users whether Claude is actively generating a response vs sitting idle waiting for input. This is valuable UX for sessions where Claude might be running long tool operations (compiling, testing) interspersed with API calls -- users want to know "is Claude still working on this?" The current `active` status is too coarse: it's true for the entire duration the process is alive, whether Claude is calling the API, running a tool, or waiting for the user.

- **Recommendation**: **Adapt** -- The core technique (fd3 monkey-patch + pipe read) is directly applicable to Agendo since Agendo also spawns Claude Code CLI processes. However, the propagation path differs significantly:

  1. **Agendo spawns via `session-process.ts`** in a worker process, not interactively. The `claude-adapter.ts` already configures spawn options. Adding `'pipe'` as the 4th stdio entry and reading fd3 from the `ManagedProcess` is straightforward.

  2. **Agendo uses PG LISTEN/NOTIFY + SSE**, not Socket.IO. The thinking state could be published as a new ephemeral event type on the session's NOTIFY channel, or as a new `agent:api_call_active` event.

  3. **Agendo needs a launcher shim**. Currently `claude-adapter.ts` spawns `claude` directly. It would need a CJS shim script similar to `claude_local_launcher.cjs` that monkey-patches `global.fetch` and writes to fd3. This shim would live in `src/lib/worker/scripts/` or similar.

  4. **Alternative approach**: Since Claude Code v1.0.20+ emits `tool_use` and `tool_result` events with structured NDJSON, Agendo could approximate thinking state from NDJSON events alone: if an `assistant` event arrives, Claude was thinking; if a `tool_result` arrives, Claude just finished a tool call and may be thinking again. This is less precise than fd3 but avoids the shim complexity. The fd3 approach is better because it captures the *actual* API call timing, not inferred timing from output events.

  Implementation effort is moderate (2-3 hours): write shim script, modify adapter spawn options, add fd3 pipe reader to session-process, add new event type, update frontend status display.
