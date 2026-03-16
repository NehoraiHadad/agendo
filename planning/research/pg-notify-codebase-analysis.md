# pg_notify Codebase Analysis

**Date**: 2026-03-16
**Scope**: All `publish()`, `subscribe()`, and `channelName()` call sites in `src/`

---

## 1. Core Module: `src/lib/realtime/pg-notify.ts`

### Connection Architecture

Two distinct PostgreSQL connection pools are used:

| Pool                       | Purpose                                 | Max connections            |
| -------------------------- | --------------------------------------- | -------------------------- |
| `listenerPool` (dedicated) | LISTEN connections for `subscribe()`    | 20                         |
| Drizzle pool (shared)      | `SELECT pg_notify(...)` for `publish()` | Shared with all DB queries |

The `listenerPool` is **multiplexed**: one PG connection per channel, not per subscriber. Multiple SSE clients watching the same session all share the same LISTEN connection.

### Channel Name Format

```
{prefix}_{uuid_without_hyphens}
```

Prefixes: `agendo_events`, `agendo_control`, `brainstorm_events`, `brainstorm_control`

Example: `agendo_events_550e8400e29b41d4a716446655440000`

### Reconnect Logic

On channel slot error:

1. Old client is immediately released (`release(true)`)
2. Old slot removed from `channels` map
3. Exponential backoff: `min(1000 * 2^n, 8000)` ms (max 8s)
4. All existing listeners are preserved on the slot's `Set<Callback>`
5. New slot created and listeners migrated
6. If no listeners remain at reconnect time, reconnect is aborted

Guards against duplicate reconnect attempts via `reconnecting: Set<string>`.

### Heartbeat

Every 60 seconds per channel slot: `SELECT 1` on the LISTEN client. Purpose is keepalive, not health monitoring. If heartbeat fails, a debug log is emitted (no reconnect triggered here — the `client.on('error')` handler does that).

### Slot Lifecycle

- **Create**: first `subscribe()` call for a channel
- **Share**: subsequent `subscribe()` calls add callbacks to the slot's Set
- **Destroy**: when last subscriber calls unsubscribe — sends `UNLISTEN`, releases PG client

### `broadcastSessionStatus(sessionId, status)` helper

A thin wrapper that constructs a `session:state` event and calls `publish()`. No subscriber — it's a "fire and broadcast" to connected SSE clients.

---

## 2. `publish()` Call Sites

### Session Domain

| File                             | Line    | Channel               | Process | Data Sent                               | Business Reason                                                                          |
| -------------------------------- | ------- | --------------------- | ------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `session-process.ts`             | 182     | `agendo_events_{id}`  | Worker  | `agent:text-delta` event                | Token streaming to browser (no log write — ephemeral)                                    |
| `session-process.ts`             | 193     | `agendo_events_{id}`  | Worker  | `agent:thinking-delta` event            | Token-level thinking streaming (no log write)                                            |
| `session-process.ts`             | 810     | `agendo_events_{id}`  | Worker  | Any `AgendoEvent`                       | Core event delivery: all tool events, state changes, agent text, init, etc.              |
| `pg-notify.ts`                   | 72      | `agendo_events_{id}`  | Both    | Synthetic `session:state` event         | Stale-reaper / zombie-reconciler / cancel route status broadcasts                        |
| `session-service.ts`             | 136     | `agendo_control_{id}` | Next.js | `{ type: 'cancel' }`                    | Cancel API route → worker                                                                |
| `session-service.ts`             | 151     | `agendo_control_{id}` | Next.js | `{ type: 'interrupt' }`                 | Interrupt API route → worker                                                             |
| `sessions/[id]/message/route.ts` | 72      | `agendo_control_{id}` | Next.js | `{ type: 'message', text, imageRef? }`  | User message delivery to live session process                                            |
| `sessions/[id]/control/route.ts` | 78, 138 | `agendo_control_{id}` | Next.js | Any `AgendoControl` payload             | Generic control relay: tool-approval, tool-result, steer, rollback, mcp-\*, rewind-files |
| `sessions/[id]/events/route.ts`  | 130     | `agendo_events_{id}`  | Next.js | Any `AgendoEventPayload`                | POST endpoint: inject synthetic event (used by team API)                                 |
| `sessions/[id]/model/route.ts`   | 44      | `agendo_control_{id}` | Next.js | `{ type: 'set-model', model }`          | Live model switch on active session                                                      |
| `sessions/[id]/mode/route.ts`    | 50      | `agendo_control_{id}` | Next.js | `{ type: 'set-permission-mode', mode }` | Live permission mode switch on active session                                            |

### Brainstorm Domain

| File                                     | Line   | Channel                                              | Process | Data Sent                                 | Business Reason                                                                               |
| ---------------------------------------- | ------ | ---------------------------------------------------- | ------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `brainstorm-orchestrator.ts`             | 1344   | `brainstorm_events_{id}`                             | Worker  | Any `BrainstormEvent`                     | Core brainstorm event delivery (wave progress, messages, status)                              |
| `brainstorm-orchestrator.ts`             | 1263   | `agendo_control_{sessionId}`                         | Worker  | `{ type: 'message', text }`               | Orchestrator → participant session (cross-worker fallback when not in `liveSessionProcs` map) |
| `brainstorm-orchestrator.ts`             | 1366   | `agendo_control_{sessionId}`                         | Worker  | `{ type: 'cancel' }`                      | Terminate participant sessions on brainstorm end                                              |
| `brainstorms/[id]/steer/route.ts`        | 15, 90 | `brainstorm_events_{id}` / `brainstorm_control_{id}` | Next.js | User steer message / steer control        | Live user steering of brainstorm waves                                                        |
| `brainstorms/[id]/end/route.ts`          | 28, 40 | `brainstorm_control_{id}` / `brainstorm_events_{id}` | Next.js | End control / `room:state` fallback       | End room, with fallback direct status if orchestrator dead                                    |
| `brainstorms/[id]/extend/route.ts`       | 31     | `brainstorm_control_{id}`                            | Next.js | `{ type: 'extend', additionalWaves }`     | Add more waves to a paused room                                                               |
| `brainstorms/[id]/participants/route.ts` | 53     | `brainstorm_control_{id}`                            | Next.js | `{ type: 'remove-participant', agentId }` | Remove participant mid-brainstorm                                                             |

**Total publish() call sites: 21** (across 12 files)

---

## 3. `subscribe()` Call Sites

| File                               | Line    | Channel                     | Process | What It Does                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------- | --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-process.ts`               | 257-264 | `agendo_control_{id}`       | Worker  | Receives all control messages (message, cancel, interrupt, redirect, tool-approval, tool-result, set-permission-mode, set-model, steer, rollback, mcp-\*). The entire bidirectional control protocol lives here. Subscribed for the full duration of the session process. |
| `sessions/[id]/events/route.ts`    | 79      | `agendo_events_{id}`        | Next.js | SSE GET: live events forwarded to browser after log file replay. One per connected browser tab. Unsubscribed when the SSE connection closes.                                                                                                                              |
| `brainstorm-orchestrator.ts`       | 496     | `agendo_events_{sessionId}` | Worker  | Per-participant: monitors each participant's session events to detect `awaiting_input` (turn complete), `agent:text` (collect response). Up to N subscriptions per brainstorm room (one per participant).                                                                 |
| `brainstorm-orchestrator.ts`       | 511     | `brainstorm_control_{id}`   | Worker  | Room control channel: receives steer/end/remove-participant/extend commands from API routes. One per brainstorm room.                                                                                                                                                     |
| `brainstorm-orchestrator.ts`       | 1158    | `agendo_events_{sessionId}` | Worker  | Synthesis session: temporary subscription during synthesis to collect the final synthesizer agent's response. Cleaned up immediately after result arrives.                                                                                                                |
| `brainstorms/[id]/events/route.ts` | 106     | `brainstorm_events_{id}`    | Next.js | SSE GET: live brainstorm events forwarded to browser after log file replay. One per connected browser tab.                                                                                                                                                                |

**Total subscribe() call sites: 6** (across 4 files)

---

## 4. The Multiplexer Analysis

**PG connections per channel**: exactly 1 (shared via multiplexer)

**Session channels created**:

- `agendo_events_{id}` — 1 per session with connected browser client
- `agendo_control_{id}` — 1 per active session (worker subscribes on claim)

**Brainstorm channels** (12 max for a large brainstorm with 10 participants):

- `brainstorm_control_{roomId}` — 1 per room
- `brainstorm_events_{roomId}` — 1 per room (if browser connected)
- `agendo_events_{sessionId}` — 1 per participant session (up to 10)

The comment in `pg-notify.ts` confirms `max: 20` was sized for a brainstorm with 13 channels max.

**Key property**: When no browser is connected to a session's SSE endpoint, there is no `agendo_events_*` LISTEN connection at all — the worker publishes into the void. The log file is the durability layer (not PG).

---

## 5. The "Dual Write" Pattern

### How `emitEvent()` works in `session-process.ts:794-818`

```
emitEvent(partial: AgendoEventPayload)
  1. ++eventSeq
  2. DB UPDATE sessions SET eventSeq = seq  [1 DB query per event]
  3. publish(agendo_events_*, full event)    [1 DB query via SELECT pg_notify]
  4. logWriter.write(serialized event)       [1 file write]
```

**Cost per event**: 2 DB queries + 1 file write.

### Is the log file the source of truth?

**Yes.** The SSE route (`sessions/[id]/events/route.ts:62-75`) confirms this:

```typescript
// 2. Catchup: replay historical events from the log file after lastEventId.
// The log file is the single source of truth for ALL agent types (Claude,
// Codex, Gemini). It already contains every AgendoEvent emitted during the
// session, including user messages — no need for agent-specific read paths.
const logContent = readFileSync(session.logFilePath, 'utf-8');
const catchupEvents = readEventsFromLog(logContent, lastEventId);
```

The comment in the code says it explicitly: **log file = source of truth**.

### On SSE reconnect: does it replay from log?

**Yes, always.** On every SSE connection:

1. Emit current status from DB (synthetic, not counted)
2. Read log file, filter events after `lastEventId`, replay all
3. Subscribe to live PG NOTIFY for new events

There is **no in-memory buffer** for missed events. PG NOTIFY is purely a live push channel with zero durability — events published when no browser is listening are permanently lost. The log file fills that gap.

### Special case: delta events

`agent:text-delta` and `agent:thinking-delta` events are published **directly** to PG NOTIFY (not written to the log file):

```typescript
// ActivityTracker.ts (line 174-194 in session-process.ts):
// publishTextDelta: emit agent:text-delta directly to PG NOTIFY (no log write)
async (text) => {
  const event: AgendoEvent = { ... type: 'agent:text-delta', text };
  await publish(channelName('agendo_events', this.session.id), event);
},
```

These are **intentionally ephemeral** — if you miss them, the complete `agent:text` event that follows IS written to the log, so reconnecting clients get the full text anyway.

### Could `fs.watch` on the log file replace pg_notify for the events direction?

**Partially**, but with significant caveats:

**What it could do**:

- SSE could tail the log file and push new lines as they appear
- This would eliminate the `agendo_events_*` channel entirely
- Log is already the durability layer, so events wouldn't be lost

**What it cannot do**:

- `agent:text-delta` events are never written to the log — they'd need to be either dropped (acceptable since `agent:text` follows) or written to the log (adding file write overhead and noise)
- `fs.watch` is not as low-latency as PG NOTIFY (filesystem notification coalescing, debounce needed)
- `fs.watch` requires the SSE process to have filesystem access to the log path — currently the log path is persisted in the DB, so it works, but it ties the SSE endpoint to the filesystem layout
- Cross-machine deployments (multiple Next.js replicas) would not work since log files are local

---

## 6. Control Direction Analysis

### Frontend → Worker (`agendo_control_{id}`)

Control message types sent by API routes to the worker:

| Type                  | Sender                                   | Receiver Action                        |
| --------------------- | ---------------------------------------- | -------------------------------------- |
| `message`             | message route, steer (brainstorm inject) | Push to agent stdin                    |
| `cancel`              | session-service, brainstorm terminate    | SIGTERM + synthetic tool-ends          |
| `interrupt`           | session-service                          | SIGINT, warm/cold resume decision      |
| `redirect`            | (not via API — session-control-handlers) | Cancel current turn, new prompt        |
| `tool-approval`       | control route                            | Pipe allow/deny to agent stdin         |
| `tool-result`         | control route                            | Send AskUserQuestion response          |
| `set-permission-mode` | mode route                               | Terminate + restart with new mode flag |
| `set-model`           | model route                              | `set_model` control_request to agent   |
| `steer`               | control route                            | Codex mid-turn injection               |
| `rollback`            | control route                            | Codex thread rollback                  |
| `mcp-set-servers`     | control route                            | Replace all MCP servers (Claude SDK)   |
| `mcp-reconnect`       | control route                            | Reconnect specific MCP server          |
| `mcp-toggle`          | control route                            | Enable/disable MCP server              |
| `rewind-files`        | control route                            | Rewind files to checkpoint             |

### Could these be replaced with direct HTTP to the Worker?

**Yes, technically.** The worker does not currently have an HTTP server, but adding one (e.g., `express` on a separate port) would allow the API route to `POST http://localhost:{workerPort}/session/{id}/control`.

**Reasons this is harder than it looks**:

1. **Worker discovery**: The Next.js app would need to know the worker's address. With PM2, they're on the same machine — easy. But this creates coupling.
2. **Worker HTTP surface**: The worker currently has zero HTTP routes. Adding a full HTTP server is non-trivial.
3. **Load balancing**: With multiple workers, the control message needs to reach the right worker (the one that owns the session). PG NOTIFY is broadcast — all workers receive it, but only the one with the live `SessionProcess` acts on it. With HTTP, you'd need session-to-worker routing.
4. **The control channel is low-frequency**: User messages are maybe once per minute per session. The overhead is negligible.

**Summary**: PG NOTIFY is a practical choice for this use case. HTTP would be faster but requires infrastructure (worker HTTP server, discovery, routing).

---

## 7. Non-Session pg_notify Uses

### `broadcastSessionStatus()` (callers outside SessionProcess)

Called by processes that change session status in the DB without owning a `SessionProcess` instance:

| Caller                        | File                           | Reason                                                       |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `StaleReaper.reap()`          | `stale-reaper.ts:92`           | After reaping stale sessions → frontend status update        |
| `reconcileOrphanedSessions()` | `zombie-reconciler.ts:111,141` | After reconciling orphaned sessions → frontend status update |
| `cancelSession()`             | `session-service.ts:133`       | Cancel API pre-status broadcast (before worker processes it) |

All three are "out-of-band status updaters" that bypass the normal `SessionProcess.transitionTo()` path.

### Brainstorm channels (`brainstorm_events_*`, `brainstorm_control_*`)

The brainstorm system is a parallel use of pg_notify with identical architecture:

- **`brainstorm_events_{roomId}`**: Worker → Frontend (same pattern as session events, with log file replay)
- **`brainstorm_control_{roomId}`**: Frontend → Worker (same pattern as session control)
- **`agendo_events_{participantSessionId}`**: Worker → Orchestrator (cross-component: participant sessions emit events that the orchestrator subscribes to for wave completion detection)

The **unique brainstorm pattern** (line 1263): the orchestrator also publishes to `agendo_control_{participantSessionId}` to inject wave messages. This is the only case where the Worker publishes to the control channel (normally that's a Frontend → Worker direction).

---

## 8. DB Cost Analysis

### Per-event cost in `SessionProcess.emitEvent()`

Every `AgendoEvent` that goes through the main emitter costs:

1. **`UPDATE sessions SET eventSeq = seq`** — 1 DB query
   Purpose: keeps eventSeq durable so SSE reconnect knows how many events exist

2. **`SELECT pg_notify(channel, payload)`** — 1 DB query
   Uses the shared Drizzle pool (not the listener pool)

3. **Log file write** — 1 file system write (sync, via `writeFileSync` in `FileLogWriter`)

**Total: 2 DB round-trips + 1 file write per event**

The `eventSeq` update is arguably the most expensive because it's a write (not just a SELECT). It also creates write amplification: for a session with 100 tool calls, that's 100+ sequential `UPDATE sessions` queries just for sequence tracking.

### Exception: delta events

`agent:text-delta` and `agent:thinking-delta` cost only **1 DB query** (`SELECT pg_notify(...)`) — no `UPDATE sessions SET eventSeq`, no file write. This was an intentional optimization since tokens stream at ~10-50/second.

### PG NOTIFY listener connections

The `listenerPool` uses **1 connection per unique channel** (not per subscriber), with max=20.

**In practice for a single user session**:

- 1 connection for `agendo_events_{sessionId}` (shared by all browser tabs watching the session)
- 1 connection for `agendo_control_{sessionId}` (worker subscriber)
  = **2 dedicated PG connections per active session**

**For a brainstorm with N participants**:

- 1 for `brainstorm_control_{roomId}` (orchestrator)
- 1 for `brainstorm_events_{roomId}` (if browser connected)
- N for `agendo_events_{participantSessionId}` (orchestrator subscribes to each)
  = **N + 2 PG connections** (e.g., 12 for a 10-participant brainstorm)

---

## 9. Summary of Findings

### Dependency Map

```
Next.js App (API routes)          Worker (session-process.ts)
        │                                    │
        │ publish(agendo_control_*)          │ subscribe(agendo_control_*)
        │ ─────────────────────────────────► │
        │                                    │
        │ subscribe(agendo_events_*)         │ publish(agendo_events_*)
        │ ◄───────────────────────────────── │
        │ [SSE → browser]                    │ [+ write to log file]
        │                                    │
        │ publish(brainstorm_control_*)      │ subscribe(brainstorm_control_*)
        │ ─────────────────────────────────► │ [orchestrator]
        │                                    │
        │ subscribe(brainstorm_events_*)     │ publish(brainstorm_events_*)
        │ ◄───────────────────────────────── │ [+ write to log file]
        │ [SSE → browser]                    │
        │                                    │ subscribe(agendo_events_{participant_*})
        │                                    │ ◄─────── participant sessions
        │                                    │ [orchestrator monitors sessions]
        │                                    │
        │                                    │ publish(agendo_control_{participant_*})
        │                                    │ ─────────────────────────────────────►
        │                                    │ [orchestrator → participant sessions]
```

### Key Observations

1. **Log file is the durability layer**, not PG NOTIFY. PG NOTIFY is a live delivery bus — events are ephemeral. All SSE reconnects read from the log file first.

2. **`agent:text-delta` / `agent:thinking-delta` events bypass the log** intentionally — they're only relevant to actively-connected clients. The complete `agent:text` event covers reconnect scenarios.

3. **The `eventSeq` UPDATE is the hidden cost**: 2 DB queries per event (UPDATE + SELECT pg_notify). For high-frequency events (many tool calls), this is potentially the most significant DB overhead.

4. **The control channel is low-frequency**: User messages, tool approvals, model changes. PG NOTIFY latency is acceptable here; HTTP would be faster but requires adding a worker HTTP server.

5. **The brainstorm orchestrator uses PG NOTIFY in both directions** (not just frontend→worker): it subscribes to participant session events to coordinate wave timing, and publishes to participant control channels to inject wave messages.

6. **No in-memory event buffer exists** — if the SSE connection drops and reconnects, it relies entirely on the log file for history. PG NOTIFY has zero replay semantics.

7. **The multiplexer prevents connection exhaustion**: Before the multiplexer was added, each SSE reconnect would create a new LISTEN connection — this was the "pool exhaustion bug" from commit `b417d18`.

### Simplification Opportunities

| Direction                                      | Current                    | Alternative                         | Effort | Risk                                                                              |
| ---------------------------------------------- | -------------------------- | ----------------------------------- | ------ | --------------------------------------------------------------------------------- |
| Worker → Frontend (events)                     | PG NOTIFY + log file       | fs.watch log file                   | Medium | Medium — latency, delta events                                                    |
| Frontend → Worker (control)                    | PG NOTIFY                  | Worker HTTP API                     | High   | High — worker HTTP server, routing                                                |
| Out-of-band status broadcast                   | `broadcastSessionStatus()` | DB polling on SSE reconnect         | Low    | Low — less real-time                                                              |
| Brainstorm orchestrator → participant sessions | PG NOTIFY                  | Direct function call (same process) | Low    | Low — already uses `getSessionProc()` as primary path, PG NOTIFY is fallback only |

The **easiest removal** is the brainstorm orchestrator's fallback `publish(agendo_control_*, message)` at line 1263 — the primary path already uses `getSessionProc()` for in-process delivery. The PG NOTIFY path only fires when the session is claimed by a different worker instance, which shouldn't happen in the single-worker deployment.

The **hardest removal** would be the control direction (Frontend → Worker), as it requires adding HTTP server infrastructure to the worker.

The **event direction** (Worker → Frontend) could theoretically use `fs.watch` but would lose delta event streaming unless those are also written to the log or removed.
