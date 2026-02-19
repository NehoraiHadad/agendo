# Session Lifecycle

Source: https://github.com/slopus/happy/blob/main/packages/happy-cli/src/claude/claudeLocal.ts (primary), with supporting code from `loop.ts`, `session.ts`, `runClaude.ts`, `daemon/run.ts`, `daemon/controlServer.ts`, `claude/claudeLocalLauncher.ts`, and `session-protocol-claude.md`

## What

Happy Coder implements a multi-layered session lifecycle architecture for managing Claude CLI processes. At the lowest level, `claudeLocal.ts` spawns the Claude process via `child_process.spawn()` with carefully constructed arguments, environment variables, and stdio configuration. Above that, `loop.ts` implements a state machine that alternates between local and remote execution modes. At the top, a persistent daemon process (`daemon/run.ts`) tracks all running sessions by PID, handles spawning from remote requests, and provides heartbeat-based liveness detection. The daemon exposes a local HTTP control server for session listing, spawning, and stopping.

The key distinction from simpler approaches: Happy treats a "session" as a long-lived concept that may involve multiple Claude process spawns across different modes (local and remote), with the daemon maintaining persistent state that outlives any individual process.

## Problem it solves

Managing Claude CLI processes is harder than it appears. The naive approach -- spawn a process and read stdout -- fails in several ways:

1. **One-time CLI flags**: Flags like `--resume` and `--continue` must only be passed on the *first* spawn. If the process is restarted (e.g. for a mode switch), passing `--resume` again causes errors. Happy solves this with `consumeOneTimeFlags()` which strips these flags after first use.

2. **Environment variable conflicts**: Running Claude inside another Claude session causes a nested-session guard error due to the `CLAUDECODE` env var. The spawning code must carefully construct a clean environment.

3. **Live vs. cold session tracking**: The daemon needs to know which sessions have live processes vs. which are "cold" (the process exited but the session can be resumed). Happy uses a `pidToTrackedSession` Map in the daemon, plus server-side `agentState` with versioned updates, to track this distinction.

4. **Graceful shutdown choreography**: When a session ends, multiple resources need cleanup in the right order: archive the session, flush socket messages, close API connections, stop MCP servers, release sleep prevention locks. Getting this wrong causes resource leaks or lost messages.

5. **Thinking state flickering**: Raw Claude output produces rapid thinking state transitions. Happy debounces thinking state changes with a 500ms delay to avoid UI flickering.

## How - Source Code

### Process Spawning (claudeLocal.ts)

The core spawn uses file descriptor 3 as a sideband channel for thinking state:

```typescript
// packages/happy-cli/src/claude/claudeLocal.ts (reconstructed from analysis)
const child = spawn(
    spawnWithShell && spawnCommand ? spawnCommand : 'node',
    spawnWithShell ? [] : spawnArgs,
    {
        stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
        signal: opts.abort,
        cwd: opts.path,
        env,
        shell: spawnWithShell,
    }
);
```

Key details:
- `stdio[3]` is set to `'pipe'` -- this creates a dedicated channel for thinking state (`fetch-start`/`fetch-end` messages), separate from the main stdout/stderr
- `signal: opts.abort` connects an AbortController so the parent can cancel the process
- `stdin: 'inherit'` -- in local mode, Claude gets direct terminal access (unlike Agendo which uses `'pipe'` for programmatic input)

### Spawn Arguments Construction (claudeLocal.ts)

Arguments are built dynamically based on session state:

```
--resume <id>          # if resuming existing session
--session-id <uuid>    # if creating with specific session ID
--append-system-prompt # with system prompt content
--mcp-config           # JSON MCP server configuration
--allowedTools         # comma-separated tool allowlist
--settings             # path to hook settings file
--dangerously-skip-permissions  # when sandboxing is active
```

### One-Time Flag Consumption (session.ts)

This prevents `--resume`/`--continue` from being passed on subsequent spawns within the same logical session:

```typescript
// packages/happy-cli/src/claude/session.ts (reconstructed from analysis)
consumeOneTimeFlags() {
    // Filters CLI arguments post-spawn, removing --continue, --resume,
    // and associated UUIDs so they are not passed again on mode switches
    this.claudeArgs = this.claudeArgs.filter(/* strips one-time flags */);
}
```

This is called after the first successful spawn. Without it, switching from local to remote mode and back would try to `--resume` with the same session ID again, causing errors.

### The Main Loop State Machine (loop.ts)

```typescript
// packages/happy-cli/src/claude/loop.ts (reconstructed from analysis)
async function loop(config) {
    const session = new Session(config);

    while (true) {
        if (session.mode === 'local') {
            const result = await claudeLocalLauncher(session);
            if (result.type === 'switch-to-remote') {
                session.onModeChange('remote');
                continue;
            }
            return result.exitCode;  // exit the loop
        } else {
            const result = await claudeRemoteLauncher(session);
            if (result.type === 'exit') return 0;
            if (result.type === 'switch-to-local') {
                session.onModeChange('local');
                continue;
            }
        }
    }
}
```

The loop enables seamless switching between local execution (direct process spawn) and remote execution (API-based, with permission gating and message queuing). Each mode returns either an exit signal or a switch signal.

### Daemon Session Tracking (daemon/run.ts)

The daemon maintains a PID-to-session map for tracking live processes:

```typescript
// packages/happy-cli/src/daemon/run.ts (reconstructed from analysis)
// pidToTrackedSession: Map<number, TrackedSession>

interface TrackedSession {
    startedBy: 'daemon' | string;
    happySessionId?: string;
    happySessionMetadataFromLocalWebhook?: Metadata;
    pid: number;
    childProcess?: ChildProcess;
    error?: string;
    directoryCreated?: boolean;
    message?: string;
    tmuxSessionId?: string;
}
```

The daemon runs a heartbeat interval (60 seconds) that prunes stale sessions -- processes whose PIDs are no longer alive. It also supports spawning sessions in tmux windows for terminal multiplexing.

### Session State via WebSocket (session.ts client)

On the remote/API side, session state is tracked through versioned WebSocket updates:

```typescript
// packages/happy-agent/src/session.ts:146-173
waitForIdle(timeoutMs = 300_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const checkIdle = (): 'archived' | boolean => {
            const meta = this.metadata as Record<string, unknown> | null;
            if (meta?.lifecycleState === 'archived') {
                return 'archived';
            }
            const state = this.agentState as Record<string, unknown> | null;
            if (!state) {
                return false;
            }
            const controlledByUser = state.controlledByUser === true;
            const requests = state.requests;
            const hasRequests = requests != null && typeof requests === 'object' && !Array.isArray(requests) && Object.keys(requests as Record<string, unknown>).length > 0;
            return !controlledByUser && !hasRequests;
        };
        // ... timeout and event listener setup
    });
}
```

"Idle" is defined as: not controlled by user AND no pending requests AND not archived. This is tracked with versioned state updates over Socket.IO, where the client ignores updates with older version numbers to prevent out-of-order state corruption.

### Graceful Shutdown Sequence (runClaude.ts)

```
1. Update session lifecycle state to "archived"
2. Send session death message
3. Flush socket and close API session
4. Stop MCP servers (happy server + hook server)
5. Release macOS sleep prevention (caffeinate)
6. Clear signal handlers
```

This happens on SIGTERM, SIGINT, uncaught exceptions, and unhandled rejections -- all routed through a single `requestShutdown()` function.

### Thinking State Debounce (claudeLocal.ts)

```
- fd 3 receives fetch-start/fetch-end messages
- Active fetches tracked by ID in a Map
- Thinking state updates debounced with 500ms timeout
- This prevents rapid on/off/on flickering in the UI
```

## Relevance to Agendo

- **What Agendo already does**: Agendo has a solid session lifecycle in `session-process.ts` that handles spawning (`adapter.spawn()`), resuming (`adapter.resume()` with `--resume sessionRef`), state transitions (active/awaiting_input/idle/ended), idle timeout, heartbeat, and graceful cancellation via SIGINT escalating to SIGKILL. The `ClaudeAdapter` in `claude-adapter.ts` constructs spawn args including `--input-format stream-json --output-format stream-json --verbose --permission-mode bypassPermissions`. It sends messages via NDJSON on stdin and supports slash commands.

- **Gap #1: One-time flag consumption**: Agendo does not strip `--resume` after first use. This is less of an issue because Agendo doesn't switch between local/remote modes -- each `SessionProcess` instance handles one spawn. But if a session process crashes and is re-spawned with the same `--resume` flag, this could cause problems. Currently Agendo creates a new `SessionProcess` per execution, so the flags are fresh each time.

- **Gap #2: Thinking state debounce**: Agendo emits `agent:thinking` events directly as they arrive from Claude's NDJSON output. There is no debouncing, which could cause rapid UI state changes. Happy's 500ms debounce on a separate fd3 channel is a more polished approach.

- **Gap #3: Dedicated sideband channel for thinking**: Happy uses stdio fd 3 as a dedicated pipe for thinking state signals (`fetch-start`/`fetch-end`), keeping them separate from main output. Agendo parses thinking from the same stdout NDJSON stream, which works but means thinking events are interleaved with content events in the same parsing pipeline.

- **Gap #4: Daemon-level multi-session tracking**: Happy's daemon maintains a `pidToTrackedSession` Map and runs a 60-second heartbeat to prune stale sessions. Agendo tracks sessions in PostgreSQL with a `heartbeatAt` column and per-session `workerId`, which is actually more robust (survives worker restarts). The daemon pattern is not needed.

- **Gap #5: Versioned state updates**: Happy uses monotonic version numbers on WebSocket state updates, ignoring updates with older versions to prevent out-of-order corruption. Agendo uses PG LISTEN/NOTIFY with monotonic `eventSeq` on the session row -- similar concept, similar robustness.

- **Gap #6: Session lifecycle states**: Happy has a richer lifecycle vocabulary with `lifecycleState: 'archived'` for permanently ended sessions vs. temporarily idle ones. Agendo has `idle` (resumable, process exited cleanly), `ended` (process exited with error or was cancelled), and `active`/`awaiting_input` (process alive). This is functionally equivalent.

- **Gap #7: Graceful shutdown choreography**: Happy has a well-defined shutdown sequence (archive -> flush -> close -> cleanup). Agendo's `onExit` handler does transition -> update endedAt -> close log writer, but doesn't have an explicit flush step. Since Agendo uses PG NOTIFY (which is transactional), events are guaranteed to be delivered if the DB write succeeds, making an explicit flush less critical.

- **Recommendation**: **Adapt selectively**
  - **Adopt thinking debounce**: Add a 300-500ms debounce to `agent:thinking` events in `session-process.ts` to prevent UI flickering. This is a small, high-value change.
  - **Skip daemon pattern**: Agendo's PostgreSQL-backed session tracking is more robust than Happy's in-memory PID map. The daemon exists in Happy because Happy is a CLI tool that needs to persist state across terminal sessions -- Agendo is a server app with a database.
  - **Skip one-time flag consumption**: Agendo creates fresh adapter instances per execution, so flag re-use is not a risk.
  - **Skip fd3 sideband**: Agendo doesn't use Claude's `--output-format json` mode (which supports fd3) -- it uses `stream-json` mode with NDJSON on stdout, which is the right choice for streaming.
  - **Consider adding AbortController**: Happy passes `signal: opts.abort` to `spawn()`, enabling clean process cancellation without manual SIGTERM/SIGKILL choreography. Agendo currently sends SIGINT via `adapter.interrupt()` then escalates to SIGKILL after 5 seconds. An AbortController would be slightly cleaner but not a significant improvement.
