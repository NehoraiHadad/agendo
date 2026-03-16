# Research: Gemini session/load & IPC to Replace pg_notify

> Date: 2026-03-16
> Builds on: `pg-notify-alternatives-research.md`, `pg-notify-architecture-decision.md`

---

## Part 1: Gemini session/load Analysis

### 1.1 How session/load Works in the ACP Protocol

The ACP (Agent Client Protocol) defines three session restoration methods, in order of preference:

| Method           | Stability    | History Replay    | Requires Running Process |
| ---------------- | ------------ | ----------------- | ------------------------ |
| `session/resume` | **UNSTABLE** | No (fastest)      | Yes                      |
| `session/load`   | Stable       | Yes (full replay) | Yes                      |
| `session/new`    | Stable       | No (fresh start)  | Yes                      |

Our `AcpTransport.loadOrCreateSession()` (`gemini-acp-transport.ts:120-178`) already implements the 3-path fallback:

1. Try `session/resume` if `agentCaps.sessionCapabilities.resume` is advertised
2. Try `session/load` if `agentCaps.loadSession` is advertised
3. Fall back to `session/new`

From the ACP schema (`schema.json:676`):

> _"The agent should: Restore the session context and conversation history, Connect to the specified MCP servers, Stream the entire conversation history back to the client via notifications."_

### 1.2 What session/load Returns

**Request parameters** (`LoadSessionRequest`):

- `sessionId` (required) — the ACP session ID to restore
- `cwd` (required) — working directory
- `mcpServers` (required) — MCP server configurations to reconnect

**Response** (`LoadSessionResponse`):

- `configOptions` — session config state
- `models` — current model state (UNSTABLE)
- `modes` — current mode state (available/current modes)

**Side effects**: During the `session/load` RPC call (before the response returns), the agent streams the entire conversation history back as `session/update` notifications through the `Client.sessionUpdate()` handler.

### 1.3 Session Update Subtypes During Replay

The `SessionNotification` discriminated union includes these `sessionUpdate` types, all of which fire during a session/load replay:

| `sessionUpdate` Value       | Description                     | Our Handler                                       |
| --------------------------- | ------------------------------- | ------------------------------------------------- |
| `user_message_chunk`        | User's original messages        | Not handled (only needed for UI replay)           |
| `agent_message_chunk`       | Agent's responses (text)        | `gemini:text-delta` via `GeminiClientHandler`     |
| `agent_thought_chunk`       | Agent's reasoning/thinking      | `gemini:thinking-delta` via `GeminiClientHandler` |
| `tool_call`                 | Tool invocation start           | `gemini:tool-start` via `GeminiClientHandler`     |
| `tool_call_update`          | Tool result/status              | `gemini:tool-end` via `GeminiClientHandler`       |
| `plan`                      | Execution plan entries          | `gemini:plan` via `GeminiClientHandler`           |
| `available_commands_update` | Slash commands available        | `gemini:commands` via `GeminiClientHandler`       |
| `current_mode_update`       | Mode change (default/yolo/plan) | `gemini:mode-change` via `GeminiClientHandler`    |
| `config_option_update`      | Config option changes           | Not handled                                       |
| `session_info_update`       | Title, metadata                 | Not handled                                       |
| `usage_update`              | Context window stats (UNSTABLE) | `gemini:usage` via `GeminiClientHandler`          |

**Key finding**: session/load replays the FULL conversation as streaming `session/update` notifications. This means our `GeminiClientHandler.sessionUpdate()` method fires for every historical message. These notifications flow through the same code path as live turn events -- they are indistinguishable from live events.

### 1.4 Can You Call session/load Without a Prompt?

Yes. `session/load` is an independent RPC method, separate from `session/prompt`. You can:

1. `initialize` (handshake)
2. `session/load` (restore history, receive all notifications)
3. ...do nothing, or send a prompt later

This is exactly what happens in `GeminiAdapter.setModel()` -- it kills the process, spawns a new one, calls `loadOrCreateSession()`, and does NOT send a prompt. The session is restored and ready for the next user message.

However, session/load is designed for active session restoration (continuing a conversation). It is NOT a read-only history API. The agent fully restores its internal state, reconnects MCP servers, and is ready to accept prompts.

### 1.5 The Critical Limitation: Process Must Be Running

**session/load REQUIRES a running Gemini CLI process.**

The lifecycle is:

1. Spawn `gemini --experimental-acp`
2. ACP handshake over stdin/stdout (NDJSON)
3. `session/load` as an RPC call over the same stdin/stdout
4. Agent reads its session file from disk, streams history to client

If the Gemini process is dead, there is no ACP connection, and session/load cannot be called. This is a fundamental constraint of the ACP protocol -- it is a process-level protocol, not a remote API.

### 1.6 Where Gemini Stores Sessions on Disk

Observed storage structure on this server:

```
~/.gemini/
├── tmp/
│   ├── agendo/                         # project-specific dir
│   │   ├── .project_root               # contains: /home/ubuntu/projects/agendo
│   │   ├── chats/                      # SESSION FILES HERE
│   │   │   ├── session-2026-03-04T20-49-410bb2ed.json
│   │   │   ├── session-2026-03-15T10-41-33ee1134.json
│   │   │   └── ...
│   │   ├── 034654c8-b5d1-4a19-98ca-.../  # per-session dirs (plans, artifacts)
│   │   │   └── plans/
│   │   └── ...
│   ├── {sha256-hash}/                  # TUI sessions (non-ACP)
│   │   └── chats/
│   │       └── session-{date}-{short-uuid}.json
│   └── ...
├── history/
│   ├── agendo/
│   │   └── .project_root
│   └── tmp/
│       └── .project_root
└── state.json
```

**Key discovery**: Both ACP sessions and TUI sessions store their data in the same `chats/` directory structure. The project directory is determined by hashing the `cwd` path (for TUI) or by project name (for ACP).

### 1.7 Session File Format

Examined `session-2025-10-16T12-41-93b60a72.json`:

```json
{
  "sessionId": "93b60a72-9197-4237-b861-d4f042b7216c",
  "projectHash": "0ab97a27c1e72dc3...",
  "startTime": "2025-10-16T12:41:25.239Z",
  "lastUpdated": "2025-10-16T12:41:58.348Z",
  "messages": [
    {
      "id": "2e404a0f-...",
      "timestamp": "2025-10-16T12:41:25.239Z",
      "type": "user",
      "content": "interactive"
    },
    {
      "id": "335560b9-...",
      "timestamp": "2025-10-16T12:41:28.214Z",
      "type": "gemini",
      "content": "I will start by using `ls -F`...",
      "thoughts": [{ "subject": "...", "description": "...", "timestamp": "..." }],
      "tokens": {
        "input": 9036,
        "output": 43,
        "cached": 0,
        "thoughts": 44,
        "tool": 0,
        "total": 9123
      },
      "model": "gemini-2.5-pro"
    }
  ]
}
```

**This is a file-based fallback candidate.** The session JSON contains the full message history with user messages, agent responses, thoughts, and token counts. However:

- The filename pattern is `session-{ISO-date}-{short-uuid}.json` where the short UUID is the first 8 chars of the sessionId
- Finding the right file requires knowing the session ID (which we store in our DB)
- The format is Gemini's internal format, not ACP `SessionUpdate` objects
- Tool calls, tool results, and plan entries are embedded differently than ACP streams them

### 1.8 File-Based Fallback Viability

**Can we read session history from disk when the process is dead?** Yes, with caveats:

| Approach                                            | Pros                                          | Cons                                                                                     |
| --------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Read `~/.gemini/tmp/{project}/chats/session-*.json` | Full history available, no process needed     | Different format than ACP notifications, filename discovery requires matching session ID |
| Spawn Gemini just for session/load                  | Uses official ACP protocol, correct format    | Spawns a full CLI process just to read history, wastes resources                         |
| Use our own log file                                | Already exists, already in AgendoEvent format | Authoritative for our UI, no Gemini dependency                                           |

**Recommendation**: Our session log file (`FileLogWriter` output) is the correct source for UI history replay. It is already used by the SSE reconnect path (`readEventsFromLog` in `events/route.ts`). The Gemini session files are an internal implementation detail of the Gemini CLI, not a public API.

The ACP `session/load` is useful only for **resuming active sessions** -- it restores the agent's internal context so it can continue the conversation. For displaying history to the user, our log files are the single source of truth.

### 1.9 Copilot and OpenCode Comparison

**Copilot** (`copilot-adapter.ts`):

- Uses the same `AcpTransport` class as Gemini
- Same `loadOrCreateSession()` 3-path fallback
- Additionally passes `--resume={sessionId}` as a CLI flag (Copilot-specific)
- Same ACP `session/load` behavior expected (full replay via `session/update`)
- Copilot stores sessions in `~/.copilot/` but internal format is unknown
- Uses `CopilotClientHandler` which has the same `sessionUpdate()` handler structure

**OpenCode** (`opencode-adapter.ts`):

- Also uses `AcpTransport` (confirmed by grep: `this.transport.loadOrCreateSession()`)
- Same ACP protocol, same session/load behavior
- Shares the ACP SDK so all notifications are identical

**Summary**: All three ACP agents (Gemini, Copilot, OpenCode) use the identical session/load mechanism through our shared `AcpTransport` class. The critical limitation (requires running process) applies equally to all three.

---

## Part 2: IPC to Replace pg_notify

### 2.1 Prior Research Summary

Two thorough research documents already exist:

- `pg-notify-alternatives-research.md` — benchmarks for 11 IPC mechanisms
- `pg-notify-architecture-decision.md` — ADR with decision matrix, recommending "keep pg_notify with optimizations"

The ADR recommended **keeping pg_notify (Option A)** with three targeted optimizations:

1. Batch event publishing
2. Skip NOTIFY for deltas when no SSE clients are watching
3. Single-connection Notifier Pattern (collapse 20 connections to 1)

The ADR also provided a detailed migration plan for **Option B (File+HTTP)** if pg_notify optimizations prove insufficient.

### 2.2 Updated Analysis: What's Changed Since the ADR

The ADR was written earlier today (same date: 2026-03-16). The question now is: given the specific IPC options requested in the task, how do they compare?

### 2.3 Options Comparison Table

| Criterion           | A: Worker HTTP + UDS   | B: WebSocket (localhost)    | C: UDS + NDJSON         | D: Cluster IPC           | E: Redis Pub/Sub |
| ------------------- | ---------------------- | --------------------------- | ----------------------- | ------------------------ | ---------------- |
| **Latency**         | ~150µs (UDS)           | ~500µs (TCP) / ~200µs (UDS) | ~130µs                  | N/A (separate PM2 procs) | ~1-2ms           |
| **Bidirectional**   | No (HTTP req/res)      | Yes (native)                | Yes (raw stream)        | N/A                      | Yes (pub/sub)    |
| **Fan-out**         | Worker manages SSE map | Multiple WS clients         | Manual multiplexing     | N/A                      | Native channels  |
| **Message framing** | HTTP built-in          | WS built-in                 | Must implement (NDJSON) | N/A                      | Built-in         |
| **Payload limit**   | None                   | None                        | None                    | N/A                      | ~512MB           |
| **Reconnect**       | HTTP retry (automatic) | Must implement              | Must implement          | N/A                      | Library handles  |
| **Dependencies**    | `net` (stdlib)         | `ws` (already in deps)      | `net` (stdlib)          | N/A                      | New (ioredis)    |
| **Complexity**      | Low-Medium             | Medium                      | Medium-High             | Not applicable           | Medium + ops     |
| **LOC estimate**    | ~200 new               | ~250 new                    | ~300 new                | N/A                      | ~150 new + infra |

**Option D (Cluster IPC) is ruled out** -- Worker and Next.js are separate PM2 processes, not cluster workers. PM2 does not support cross-process IPC between independently managed services.

**Option E (Redis) is ruled out** -- adds infrastructure on a memory-constrained server (16GB RAM, already running Next.js + Worker + Terminal + PM2 + PostgreSQL).

### 2.4 The Recommended Approach: Option B Modified — File-Watch + Worker HTTP on UDS

This is the "Option B" from the existing ADR, which scored highest (7.8/10) in the decision matrix. Here is the refined design addressing specific questions from the task.

#### Architecture

```
                    Events Path (Worker → Next.js)
                    ================================
Worker (session-process.ts)
  → writes event to log file (already happens)
  → fs.watch() in SSE route detects new bytes
  → reads new lines from last offset
  → pushes to SSE ReadableStream
  → browser EventSource receives it

                    Control Path (Next.js → Worker)
                    ================================
Browser sends POST /api/sessions/{id}/message
  → API route POSTs to Worker HTTP on UDS
  → Worker HTTP handler dispatches to onControl()
```

#### Events Path: File-Watch Detail

```typescript
// src/lib/realtime/file-watcher.ts (~100 LOC)
import { watch, read, open, close } from 'node:fs';

export class LogTailer {
  private fd: number;
  private offset: number;
  private watcher: ReturnType<typeof watch>;
  private listeners = new Set<(line: string) => void>();

  constructor(filePath: string, startOffset = 0) {
    this.fd = openSync(filePath, 'r');
    this.offset = startOffset;
    // Watch the specific file (not directory) — reliable on Linux inotify
    this.watcher = watch(filePath, () => this.readNewLines());
  }

  private readNewLines() {
    // Read from this.offset to EOF
    const buf = Buffer.alloc(64 * 1024); // 64KB read buffer
    let bytesRead: number;
    while ((bytesRead = readSync(this.fd, buf, 0, buf.length, this.offset)) > 0) {
      this.offset += bytesRead;
      const text = buf.subarray(0, bytesRead).toString('utf-8');
      // Split into lines, emit complete ones
      for (const line of text.split('\n').filter(Boolean)) {
        for (const cb of this.listeners) cb(line);
      }
    }
  }

  subscribe(cb: (line: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.close();
    };
  }

  close() {
    this.watcher.close();
    closeSync(this.fd);
  }
}
```

**How session routing works**: Each SSE connection creates a `LogTailer` for the specific session's log file. The log file path is stored in `session.logFilePath`. Multiple SSE connections to the same session each get their own `LogTailer` instance (or share one via a multiplexer, same as current pg_notify pattern). The kernel's inotify does the routing -- each file has its own inotify watch, so events for session A only wake up tailers watching session A's log file.

**How SSE reconnect works**:

1. Browser disconnects (network drop, tab close)
2. Browser reconnects with `Last-Event-ID` header or `?lastEventId=N` query param
3. SSE route reads log file from beginning, filters to events after `lastEventId`
4. Creates new `LogTailer` starting at current file size (only new events from now)
5. This is **exactly what happens today** -- the reconnect path is already file-based (`readEventsFromLog` in `events/route.ts:65-74`). The only change is replacing the `subscribe()` call for live events.

#### Control Path: Worker HTTP on UDS

```typescript
// src/lib/worker/worker-http.ts (~80 LOC)
import { createServer } from 'node:http';

const SOCKET_PATH = '/tmp/agendo-worker.sock';

export function startWorkerHttp(getSessionProc: (id: string) => SessionProcess | undefined) {
  // Clean up stale socket from previous crash
  try {
    unlinkSync(SOCKET_PATH);
  } catch {}

  const server = createServer(async (req, res) => {
    // POST /control/:sessionId
    const match = req.url?.match(/^\/control\/([0-9a-f-]{36})$/);
    if (req.method === 'POST' && match) {
      const sessionId = match[1];
      const proc = getSessionProc(sessionId);
      if (!proc) {
        res.writeHead(404).end('Session not found');
        return;
      }
      const body = await readBody(req);
      await proc.onControl(body);
      res.writeHead(200).end('ok');
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(SOCKET_PATH);
  return server;
}
```

Next.js API routes call the worker:

```typescript
// src/lib/realtime/worker-client.ts (~40 LOC)
import { request } from 'node:http';

const SOCKET_PATH = '/tmp/agendo-worker.sock';

export function sendControl(sessionId: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: SOCKET_PATH, path: `/control/${sessionId}`, method: 'POST' },
      (res) => (res.statusCode === 200 ? resolve() : reject(new Error(`${res.statusCode}`))),
    );
    req.end(JSON.stringify(payload));
  });
}
```

#### How Worker Shutdown/Restart Is Handled

**Events path** (file-watch): Unaffected by worker restart. The log file persists on disk. When the worker restarts and the session resumes, it continues appending to the same log file. The `LogTailer` keeps watching. If the worker crashes and the file stops growing, the `LogTailer` simply idles -- no error, no cleanup needed.

**Control path** (HTTP on UDS): When the worker restarts, it recreates the Unix domain socket (deleting the stale one first). During the brief restart window (~2-5 seconds):

- API routes that POST to the socket get `ECONNREFUSED`
- The API route should catch this and return 503 (worker unavailable)
- Browser retries the action (messages, tool approvals) after a short delay
- This is the same behavior as today: if pg_notify publishes during a worker restart, the event goes to void

**Graceful shutdown**: `safe-restart-agendo.sh` already waits for active sessions to end. For the worker, `SIGTERM` → drain active sessions → close HTTP server → exit. The HTTP server's `close()` stops accepting new connections and finishes in-flight requests.

### 2.5 Estimated Lines of Code

| New/Modified File                              | Change                                                 | LOC                                       |
| ---------------------------------------------- | ------------------------------------------------------ | ----------------------------------------- |
| `src/lib/realtime/file-watcher.ts`             | NEW: LogTailer with inotify                            | +100                                      |
| `src/lib/worker/worker-http.ts`                | NEW: HTTP server on UDS                                | +80                                       |
| `src/lib/realtime/worker-client.ts`            | NEW: HTTP client for control                           | +40                                       |
| `src/app/api/sessions/[id]/events/route.ts`    | Replace `subscribe()` with LogTailer                   | ~20 modified                              |
| `src/app/api/sessions/[id]/message/route.ts`   | Replace `publish()` with `sendControl()`               | ~5 modified                               |
| `src/app/api/sessions/[id]/control/route.ts`   | Replace `publish()` with `sendControl()`               | ~5 modified                               |
| `src/app/api/sessions/[id]/mode/route.ts`      | Replace `publish()` with `sendControl()`               | ~5 modified                               |
| `src/app/api/sessions/[id]/model/route.ts`     | Replace `publish()` with `sendControl()`               | ~5 modified                               |
| `src/lib/services/session-service.ts`          | Replace `publish()/broadcast()`                        | ~10 modified                              |
| `src/lib/worker/session-process.ts`            | Remove `publish()` calls for events                    | ~-15 removed                              |
| `src/lib/worker/brainstorm-orchestrator.ts`    | Replace publish/subscribe                              | ~30 modified                              |
| `src/app/api/brainstorms/*/route.ts` (4 files) | Replace `publish()` with `sendControl()`               | ~20 modified                              |
| `src/lib/realtime/pg-notify.ts`                | DELETE (or keep `broadcastSessionStatus` as log-write) | -232 removed                              |
| Stale-reaper, zombie-reconciler                | Write status to log file instead of broadcast          | ~10 modified                              |
| **Total**                                      |                                                        | **~220 new, ~125 modified, ~250 removed** |

**Net change**: ~95 fewer lines of code overall (220 new - 125 modified overhead + 250 removed).

---

## Part 3: How Reconnect Works in the New Architecture

### Current Reconnect Flow (pg_notify)

```
1. Browser EventSource disconnects
2. Browser auto-reconnects with Last-Event-ID header
3. SSE route reads session from DB
4. Reads log file → filters events after lastEventId → sends catchup
5. Calls subscribe(pg_notify_channel) → receives new live events
```

### New Reconnect Flow (file-watch)

```
1. Browser EventSource disconnects
2. Browser auto-reconnects with Last-Event-ID header
3. SSE route reads session from DB
4. Reads log file → filters events after lastEventId → sends catchup
5. Creates LogTailer(logFilePath, currentFileSize) → receives new live events
```

Steps 1-4 are **identical**. Step 5 changes from pg_notify subscription to a file tailer. The reconnect semantics are preserved perfectly because the log file was always the source of truth for replay.

### CLI-Native Replay Integration

For sessions that need to resume after process death (cold resume), the existing flow works:

1. Agendo DB has `session.sessionRef` (the ACP/Claude session ID)
2. Worker spawns new agent process
3. ACP: `session/load` replays history as `session/update` notifications
4. Claude SDK: persistent session auto-restores context
5. Codex app-server: `thread/resume` restores context
6. New events from the resumed session go to the log file → file watcher picks them up

The IPC mechanism change does not affect CLI-native replay at all -- it operates at a different layer (agent process ↔ worker adapter).

---

## Part 4: Migration Plan — Which Files Change

### Phase 1: Control Channel (1 day, low risk)

Create `worker-http.ts` and `worker-client.ts`. Update all API routes that currently call `publish(channelName('agendo_control', ...))` to use `sendControl()` instead. Test all control actions work.

**Files changed:**

- `src/lib/worker/worker-http.ts` (NEW)
- `src/lib/realtime/worker-client.ts` (NEW)
- `src/app/api/sessions/[id]/message/route.ts`
- `src/app/api/sessions/[id]/control/route.ts`
- `src/app/api/sessions/[id]/mode/route.ts`
- `src/app/api/sessions/[id]/model/route.ts`
- `src/lib/services/session-service.ts`
- `src/app/api/brainstorms/[id]/steer/route.ts`
- `src/app/api/brainstorms/[id]/end/route.ts`
- `src/app/api/brainstorms/[id]/extend/route.ts`
- `src/app/api/brainstorms/[id]/participants/route.ts`
- `src/lib/worker/brainstorm-orchestrator.ts` (control publish paths)
- Worker entry point (start HTTP server)

### Phase 2: Event Channel (1.5 days, medium risk)

Create `file-watcher.ts`. Update SSE routes to use `LogTailer` instead of pg_notify subscribe. Remove `publish()` calls from `session-process.ts` event emission. Update out-of-band broadcasters.

**Files changed:**

- `src/lib/realtime/file-watcher.ts` (NEW)
- `src/app/api/sessions/[id]/events/route.ts`
- `src/app/api/brainstorms/[id]/events/route.ts`
- `src/lib/worker/session-process.ts` (remove publish calls)
- `src/lib/worker/brainstorm-orchestrator.ts` (event publish + subscribe paths)
- `src/lib/worker/stale-reaper.ts`
- `src/worker/zombie-reconciler.ts`

### Phase 3: Cleanup (0.5 day)

- Delete `src/lib/realtime/pg-notify.ts`
- Remove listener pool from config
- Update `src/lib/config.ts` if any pg_notify config exists
- Update tests that mock pg_notify
- Update architecture docs

### Phase 0 (Alternative): Quick Wins Without Migration

If the full migration is deferred, these optimizations from the ADR can be applied immediately:

1. **Skip NOTIFY for delta events when no browser is watching** — check `channels.get()` before publish
2. **Debounce eventSeq updates** — flush every 5s instead of per-event
3. **Single-connection Notifier Pattern** — collapse listener pool from 20 to 1 connection

---

## Part 5: Key Conclusions

### Gemini session/load

1. **session/load replays full history** as `session/update` notifications through the existing `ClientHandler.sessionUpdate()` callback. All ACP update types fire during replay.
2. **Requires a running Gemini process** -- cannot read history from a dead session. This is a fundamental ACP protocol constraint shared by Gemini, Copilot, and OpenCode.
3. **Gemini stores sessions as JSON files** at `~/.gemini/tmp/{project}/chats/session-{date}-{shortId}.json`. These files contain full message history, thoughts, and token counts. However, this is an internal format, not a public API.
4. **Our log files are the correct UI history source**. session/load is for restoring agent context (so it can continue working), not for displaying history to users. The SSE reconnect path already uses log files, and that should remain unchanged.

### IPC Recommendation

1. **The ADR's recommendation to keep pg_notify with optimizations is sound** for the current scale (1-5 concurrent sessions).
2. **When migration is needed**, Option B (File-Watch + Worker HTTP on UDS) is the clear winner: scores highest in the decision matrix, touches ~20 files, results in ~95 fewer lines of code overall, and aligns with the existing architecture where log files are already the source of truth for event replay.
3. **The migration is low-to-medium risk** because the event path already uses log files for reconnect (only the live subscription changes), and the control path is a straightforward HTTP replacement.
4. **WebSocket (Option B from the task) and raw UDS (Option C) are over-engineered** for this use case. HTTP-on-UDS for control + file-watch for events is simpler, uses fewer dependencies, and provides natural request/response semantics for control messages.
