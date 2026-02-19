# Interrupt & Cancellation

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/sdk/query.ts

## What

Happy implements a **multi-layer interrupt and cancellation architecture** that uses three complementary mechanisms: (1) an AbortController/AbortSignal system for process-level cancellation, (2) a **stdin-based `interrupt` control request** sent as JSON to the Claude Code SDK's `stream-json` input, and (3) synthetic "interrupted tool result" messages that close out any in-flight tool calls when a turn is aborted. The stdin interrupt is the most novel mechanism -- it allows graceful mid-turn interruption without killing the process, by writing a structured JSON control message to the child process's stdin.

## Problem it solves

Naive approaches to cancelling a running Claude turn fail because:

1. **SIGINT kills the process entirely** -- a persistent session process cannot simply be killed when you want to stop a single turn; you'd lose the process and need to cold-start a new one for the next message.
2. **Orphaned tool calls** -- when a turn is interrupted mid-execution, the Claude process may have started tool calls (file edits, subagent spawns) that never received results. Without synthetic interrupted tool results, the session log becomes inconsistent, and the frontend shows perpetually-spinning tool calls.
3. **Race conditions between cancel and next message** -- if a user sends a new message while Claude is still working, the system needs to abort the current turn cleanly, emit proper `turn-end(status="cancelled")` events, and then start processing the new message. This requires coordinated abort signaling, not just process killing.

## How - Source Code

### 1. Stdin Interrupt Control Request (SDK Layer)

The `Query` class in the SDK exposes an `interrupt()` method that writes a JSON control request to the child process's stdin:

```typescript
// packages/happy-cli/src/claude/sdk/query.ts:108-117
  /**
   * Send interrupt request to Claude
   */
  async interrupt(): Promise<void> {
    if (!this.childStdin) {
      throw new Error('Interrupt requires --input-format stream-json')
    }

    await this.request({
      subtype: 'interrupt'
    }, this.childStdin)
  }
```

This calls the private `request()` method which formats and writes the JSON message:

```typescript
// packages/happy-cli/src/claude/sdk/query.ts:122-140
  /**
   * Send control request to Claude process
   */
  private request(request: ControlRequest, childStdin: Writable): Promise<SDKControlResponse['request']> {
    const requestId = Math.random().toString(36).substring(2, 15)
    const sdkRequest: SDKControlRequest = {
      request_id: requestId,
      type: 'control_request',
      request
    }

    return new Promise((resolve, reject) => {
      this.pendingControlResponses.set(requestId, (response) => {
        if (response.subtype === 'success') {
          resolve(response)
        } else {
          reject(new Error(response.error))
        }
      })

      childStdin.write(JSON.stringify(sdkRequest) + '\n')
    })
  }
```

The **wire format** of the interrupt message sent to stdin is:

```json
{
  "request_id": "<random-id>",
  "type": "control_request",
  "request": {
    "subtype": "interrupt"
  }
}
```

The corresponding TypeScript type is:

```typescript
// packages/happy-cli/src/claude/sdk/types.ts:78-81
export interface InterruptRequest extends ControlRequest {
    subtype: 'interrupt'
}
```

### 2. AbortController for Process-Level Cancellation

The local launcher creates an AbortController and passes its signal to the `claudeLocal()` spawn:

```typescript
// packages/happy-cli/src/claude/claudeLocalLauncher.ts:34-46
    // Handle abort
    let exitReason: LauncherResult | null = null;
    const processAbortController = new AbortController();
    let exutFuture = new Future<void>();
    try {
        async function abort() {

            // Send abort signal
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }

            // Await full exit
            await exutFuture.promise;
        }
```

The abort signal is passed directly to Node's `spawn()`:

```typescript
// packages/happy-cli/src/claude/claudeLocal.ts:184-193
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

When `signal` is aborted, Node automatically sends SIGTERM to the child process. The exit handler distinguishes this from unexpected terminations:

```typescript
// packages/happy-cli/src/claude/claudeLocal.ts:248-258
                child.on('exit', async (code, signal) => {
                    // ...sandbox cleanup...

                    if (signal === 'SIGTERM' && opts.abort.aborted) {
                        // Normal termination due to abort signal
                        r();
                    } else if (signal) {
                        reject(new Error(`Process terminated with signal: ${signal}`));
                    } else if (code !== 0 && code !== null) {
                        // Non-zero exit code - propagate it
                        reject(new ExitCodeError(code));
                    } else {
                        r();
                    }
                });
```

For the remote path (SDK-based), the abort signal is passed to the `query()` function which attaches a SIGTERM cleanup handler:

```typescript
// packages/happy-cli/src/claude/sdk/query.ts:267-271
    // Setup cleanup
    const cleanup = () => {
        if (!child.killed) {
            child.kill('SIGTERM')
        }
    }

    config.options?.abort?.addEventListener('abort', cleanup)
    process.on('exit', cleanup)
```

### 3. Turn Cancellation with Synthetic Tool Results

When the launcher aborts, the remote launcher tracks all ongoing tool calls and generates synthetic error results for each one:

```typescript
// packages/happy-cli/src/claude/claudeRemoteLauncher.ts:281-295
            } finally {

                logger.debug('[remote]: launch finally');

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();
```

The `generateInterruptedToolResult()` method creates a user message with an error tool result:

```typescript
// packages/happy-cli/src/claude/utils/sdkToLogConverter.ts:193-234
    generateInterruptedToolResult(toolUseId: string, parentToolUseId?: string | null): RawJSONLines {
        const uuid = randomUUID()
        const timestamp = new Date().toISOString()
        const errorMessage = "[Request interrupted by user for tool use]"

        // Determine if this is a sidechain and get parent UUID
        let isSidechain = false
        let parentUuid: string | null = this.lastUuid

        if (parentToolUseId) {
            isSidechain = true
            // Look up the parent tool's UUID
            parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? null
            // Track this tool in the sidechain map
            this.sidechainLastUUID.set(parentToolUseId, uuid)
        }

        const logMessage: RawJSONLines = {
            type: 'user',
            isSidechain: isSidechain,
            ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
            uuid,
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        content: errorMessage,
                        is_error: true,
                        tool_use_id: toolUseId
                    }
                ]
            },
            parentUuid: parentUuid,
            userType: 'external' as const,
            cwd: this.context.cwd,
            sessionId: this.context.sessionId,
            version: this.context.version,
            gitBranch: this.context.gitBranch,
            timestamp,
            toolUseResult: `Error: ${errorMessage}`
        } as any

        // Update last UUID for tracking
        this.lastUuid = uuid

        return logMessage
    }
```

### 4. Abort-Triggered Mode Switch

When a new user message arrives while Claude is working in local mode, the launcher aborts the current process and switches to remote mode:

```typescript
// packages/happy-cli/src/claude/claudeLocalLauncher.ts:74-79
        session.queue.setOnMessage((message: string, mode) => {
            // Switch to remote mode when message received
            doSwitch();
        }); // When any message is received, abort current process, clean queue and switch to remote mode
```

The `doAbort()` function also emits a `turn-end(status='cancelled')` event before aborting:

```typescript
// packages/happy-cli/src/claude/claudeLocalLauncher.ts:48-62
        async function doAbort() {
            logger.debug('[local]: doAbort');

            // Switching to remote mode
            if (!exitReason) {
                exitReason = { type: 'switch' };
            }

            session.client.closeClaudeSessionTurn('cancelled');

            // Reset sent messages
            session.queue.reset();

            // Abort
            await abort();
        }
```

### 5. Top-Level SIGINT/SIGTERM Handling

The main `runClaude.ts` registers signal handlers for the outer process:

```typescript
// packages/happy-cli/src/claude/runClaude.ts:339-340
    // Handle termination signals
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
```

The cleanup function updates session metadata to `archived`, sends a death message, flushes the socket, and exits:

```typescript
// packages/happy-cli/src/claude/runClaude.ts:308-337
    const cleanup = async () => {
        logger.debug('[START] Received termination signal, cleaning up...');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));

                // Cleanup session resources (intervals, callbacks)
                currentSession?.cleanup();

                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Stop caffeinate
            stopCaffeinate();

            // Stop Happy MCP server
            happyServer.stop();

            // Stop Hook server and cleanup settings file
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath);

            logger.debug('[START] Cleanup complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[START] Error during cleanup:', error);
            process.exit(1);
        }
    };
```

## Relevance to Agendo

- **What Agendo already does**: Agendo's `session-process.ts` handles cancellation by calling `this.adapter.interrupt()`, which sends `SIGINT` to the child process via `this.childProcess?.kill('SIGINT')` (in `claude-adapter.ts:80-81`). It also has a SIGKILL escalation timer. However, this is a blunt approach -- SIGINT kills the interactive Claude process entirely. There is no stdin-based interrupt, no synthetic tool result cleanup, and no turn-level (vs process-level) distinction.

- **Gap this fills**: Three critical gaps:
  1. **Stdin interrupt control request**: Agendo does not send the `{"type": "control_request", "request": {"subtype": "interrupt"}}` JSON message to Claude's stdin. This is the **proper** way to interrupt a running turn without killing the process, but it requires `--input-format stream-json` and `--output-format stream-json` mode (which Agendo already uses for persistent sessions). With this, Agendo could interrupt a turn gracefully while keeping the session process alive.
  2. **Synthetic interrupted tool results**: When Agendo cancels a session, any in-flight tool calls are left dangling in the frontend. There is no mechanism to emit `tool_result` messages with `is_error: true` and `"[Request interrupted by user for tool use]"` content for each tracked tool call.
  3. **Turn-level vs process-level cancellation**: Agendo conflates "cancel this turn" with "kill the process." Happy separates these -- `interrupt()` stops the current turn; `abort()` terminates the process. This distinction is important for persistent sessions where you want to cancel work but keep the process alive for the next message.

- **Recommendation**: **Adopt** -- all three mechanisms should be implemented:
  1. Add a `sendInterrupt()` method to `claude-adapter.ts` that writes the interrupt control request JSON to stdin (requires the process to be in `stream-json` mode, which persistent sessions already use). Keep `SIGINT` as a fallback for non-persistent/legacy mode.
  2. Track active tool call IDs in session-process or the adapter. On cancellation, generate synthetic `tool_result` events with `is_error: true` and emit them as `agent:tool_result` events via the SSE/NOTIFY pipeline.
  3. Separate `interrupt()` (turn-level: send stdin interrupt, keep process alive) from `terminate()` (process-level: SIGINT + SIGKILL escalation). The cancel API route should use `interrupt()` by default for persistent sessions, falling back to `terminate()` only when the process fails to respond.
