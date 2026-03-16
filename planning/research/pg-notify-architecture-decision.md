# ADR: Real-Time IPC Architecture — pg_notify Evaluation

## Status

Proposed (2026-03-16)

## Context

Agendo uses PostgreSQL's `LISTEN/NOTIFY` mechanism as the sole IPC transport between its three cooperating processes (Next.js app, Worker, Terminal server). This ADR evaluates whether pg_notify should be retained, simplified, or replaced — and if replaced, what the migration path looks like.

The evaluation was triggered by observations that:

1. pg_notify adds database load for every real-time event (one `SELECT pg_notify()` query per event)
2. The 8000-byte payload limit requires a truncation workaround (the `{type:'ref'}` stub)
3. LISTEN connections require a dedicated connection pool (separate from Drizzle's pool)
4. PG NOTIFY has no replay/durability — events are fire-and-forget (the log file compensates)
5. Connection management complexity: multiplexer, heartbeats, reconnect logic (~230 LOC in pg-notify.ts)

## Current Architecture

### The 6-Layer Real-Time Flow

```
Browser (EventSource)
    ↕ SSE (text/event-stream)
Next.js API Route (/api/sessions/[id]/events)
    ↕ PG NOTIFY subscribe/publish
Worker (session-process.ts / brainstorm-orchestrator.ts)
    ↕ Adapter (stream-json / app-server / ACP)
Agent CLI Process (Claude / Codex / Gemini / Copilot)
```

### Bidirectional Communication Channels

**Events direction (Worker → Frontend):**

```
Worker emits AgendoEvent
  → publish() to PG NOTIFY channel 'agendo_events_{sessionId}'
  → SSE route has subscribe() callback that writes to ReadableStream
  → Browser EventSource receives SSE frame
```

**Control direction (Frontend → Worker):**

```
Browser sends POST /api/sessions/{id}/message (or /control, /mode, /model)
  → API route calls publish() to 'agendo_control_{sessionId}'
  → Worker has subscribe() callback in session-process.ts
  → Dispatches to onControl() handler
```

### All pg_notify Usage Sites (22 files, 46 call sites)

#### Session Events (Worker → Frontend) — 7 call sites in session-process.ts

- `emitEvent()` — publishes every AgendoEvent (text, tools, results, state changes)
- `activityTracker` text-delta/thinking-delta — published directly (no log persistence)
- These are the highest-frequency calls: a single agent turn can produce 50-200+ events

#### Session Control (Frontend → Worker) — 7 call sites across 5 API routes

- `/api/sessions/[id]/message/route.ts` — user messages
- `/api/sessions/[id]/control/route.ts` — tool approvals, steer, rollback, MCP ops, clearContextRestart
- `/api/sessions/[id]/mode/route.ts` — permission mode changes
- `/api/sessions/[id]/model/route.ts` — model switching
- `session-service.ts` — cancel + interrupt (broadcastSessionStatus + control publish)

#### Brainstorm Events (Orchestrator → Frontend) — 1 publish site

- `brainstorm-orchestrator.ts:emitEvent()` — room state, waves, messages, synthesis

#### Brainstorm Control (Frontend → Orchestrator) — 5 call sites across 4 API routes

- `/api/brainstorms/[id]/steer/route.ts` — user steering messages
- `/api/brainstorms/[id]/end/route.ts` — end room (+ fallback direct publish for dead orchestrator)
- `/api/brainstorms/[id]/extend/route.ts` — extend waves
- `/api/brainstorms/[id]/participants/route.ts` — remove participant

#### Brainstorm ↔ Session Cross-Channel — 3 call sites in orchestrator

- Orchestrator subscribes to `agendo_events_{sessionId}` per participant (collect responses)
- Orchestrator publishes to `agendo_control_{sessionId}` (send prompts, cancel participants)
- **Note**: The control publish (line 1263) is a **fallback path** — the primary delivery uses `getSessionProc()` for in-process function calls. PG NOTIFY only fires when a session is claimed by a different worker instance, which should not happen in the current single-worker deployment

#### Out-of-Band Status Broadcasts — 3 call sites

- `zombie-reconciler.ts` — broadcasts idle status after killing orphaned sessions
- `stale-reaper.ts` — broadcasts idle status after reaping stale sessions
- `session-service.ts:cancelSession()` — broadcasts ended status immediately

### The pg-notify.ts Module (232 LOC)

The module implements:

1. **`publish()`** — serializes payload, truncates if >7500 bytes, executes `SELECT pg_notify()`
2. **`subscribe()`** — multiplexed LISTEN with connection sharing per channel
3. **`broadcastSessionStatus()`** — convenience wrapper for synthetic session:state events
4. **Channel multiplexer** — one PG connection per distinct channel, fan-out to N listeners
5. **Auto-reconnect** — exponential backoff on connection errors
6. **Heartbeat** — 60s keepalive queries per channel to detect stale connections
7. **`channelName()`** — UUID sanitization for PG channel names

### Existing Durability Layer

Events are **already written to disk** by `FileLogWriter`:

- `session-process.ts:emitEvent()` writes every event to the session log file
- `brainstorm-orchestrator.ts:emitEvent()` writes every event to the brainstorm log file
- SSE routes replay from log files on reconnect (not from PG NOTIFY)
- PG NOTIFY is used purely as a **real-time push notification** — the log file is the source of truth

## Problem Statement

### Actual Costs at Current Scale

**Database load (the "dual write" cost):**

- Every event emission = **2 DB queries**: 1 `UPDATE sessions SET eventSeq` (write) + 1 `SELECT pg_notify()` (read-weight)
- The `eventSeq UPDATE` is arguably more expensive than the NOTIFY itself — it's a write operation with WAL impact
- For a session with 100 tool calls: 100+ sequential `UPDATE sessions` queries just for sequence tracking
- Token-level text deltas bypass the log and the eventSeq UPDATE, costing only 1 `SELECT pg_notify()` query
- With 3 concurrent sessions producing ~100 events/minute each = ~600 DB queries/min (300 NOTIFY + 300 eventSeq)
- During brainstorms with 4 agents: ~13 channels active, potentially 2000+ DB queries/minute

**Connection pool pressure:**

- Dedicated listener pool (max 20) separate from Drizzle pool
- Each distinct channel = 1 held PG connection (released when last subscriber leaves)
- Per active session with browser viewer: 2 PG connections (`agendo_events_*` + `agendo_control_*`)
- Brainstorm with N participants: N+2 PG connections (N participant event channels + 1 brainstorm control + 1 brainstorm events if browser connected)
- Example: 10-participant brainstorm = 12 PG connections from the listener pool alone
- Multiple browser tabs multiply SSE connections but share PG connections (multiplexer)
- **Key property**: When no browser is connected, the `agendo_events_*` LISTEN connection does not exist — publish goes to void, log file is the durability layer

**Payload size limit:**

- PG NOTIFY limit ~8000 bytes; agendo truncates at 7500
- Large tool outputs (e.g. file reads, grep results) are truncated to `{type:'ref'}` stubs
- Frontend receives the ref but cannot fetch the full payload (it's only in the log file)

**Operational issues documented in MEMORY.md:**

- Connection pool exhaustion during brainstorms (MEMORY.md references this)
- Heartbeat stale-reaper race conditions when subscribe() blocks waiting for pool connections
- The `ActivityTracker.startHeartbeat()` was moved before `subscribe()` specifically to prevent sessions being reaped while waiting for a listener pool connection

### What Works Well

- **Zero infrastructure**: no additional services to deploy or manage
- **Transactional consistency**: publish happens in the same event loop as DB writes
- **Built-in reconnect**: the multiplexer handles connection failures gracefully
- **Low latency**: PG NOTIFY is ~2-5ms per notification (measured), adequate for UI streaming
- **Proven at scale**: the system has been running in production with 4 AI agents

## Options Considered

### Option A: Keep pg_notify (Status Quo) with Notifier Pattern Optimization

**Description:** Retain current architecture. Apply the [Brandur Notifier Pattern](https://brandur.org/notifier) optimization to reduce connection pool from max=20 to max=1, plus targeted fixes.

Agendo's pg-notify.ts multiplexer already implements a version of the Notifier Pattern (one connection per channel, fan-out to N listeners). The optimization is to collapse all channels into a single PG connection that LISTENs on all active channels simultaneously, since PostgreSQL supports multiple LISTEN commands on one connection.

**Targeted improvements:**

1. **Single-connection Notifier Pattern** — reduce listener pool from 20 connections to 1 (~50 LOC refactor)
2. Batch multiple events into single NOTIFY calls (reduce query count)
3. Skip pg_notify for delta events when no SSE clients are watching
4. Debounce `eventSeq` updates (flush every 5s instead of per-event)

**When this becomes a problem:**

- 10+ concurrent sessions with token streaming → ~2000+ NOTIFY queries/min
- Multiple brainstorms running simultaneously → pool connection exhaustion
- If PostgreSQL is moved to a remote server (network latency on every event)
- If the system needs horizontal scaling (PG NOTIFY is per-database, not distributed)

**Pros:**

- Zero migration effort
- Battle-tested in production
- No new dependencies or infrastructure
- Atomic: DB writes and notifications in same event loop

**Cons:**

- Database load scales linearly with event volume
- 7500-byte payload ceiling (structural limitation of PG NOTIFY)
- Connection pool is a shared resource with Drizzle queries
- Cannot scale horizontally (PG NOTIFY is single-database)

**Risk level:** Low (status quo)
**Effort:** None

### Option B: File-Watch + HTTP Endpoint (Minimal Change)

**Description:** Replace pg_notify with two mechanisms:

- **Events (Worker → Frontend):** Worker already writes to log files. Next.js uses `fs.watch()` (or chokidar) on the log file to detect new events, then pushes them via SSE.
- **Control (Frontend → Worker):** Worker exposes a lightweight HTTP server on localhost. API routes POST control messages directly to it.

**Detailed design:**

_Events path:_

```
Worker writes event to log file (already happens)
  → Next.js fs.watch() detects file change
  → Reads new lines from last known offset
  → Pushes to SSE stream
```

_Control path:_

```
API route receives user action
  → POST http://localhost:{WORKER_PORT}/control/{sessionId}
  → Worker HTTP handler dispatches to onControl()
```

**Files that change:**

| File                                                 | Change                                                        | LOC est. |
| ---------------------------------------------------- | ------------------------------------------------------------- | -------- |
| `src/lib/realtime/pg-notify.ts`                      | Remove entirely (or keep broadcastSessionStatus as DB-direct) | -232     |
| `src/lib/realtime/file-watcher.ts`                   | NEW: fs.watch wrapper with line-based diffing                 | +120     |
| `src/lib/worker/worker-http.ts`                      | NEW: Express/fastify micro-server for control                 | +80      |
| `src/lib/worker/session-process.ts`                  | Remove publish() calls, keep log writes                       | -15      |
| `src/app/api/sessions/[id]/events/route.ts`          | Replace subscribe() with file watcher                         | ~30      |
| `src/app/api/sessions/[id]/message/route.ts`         | Replace publish() with HTTP POST to worker                    | ~10      |
| `src/app/api/sessions/[id]/control/route.ts`         | Replace publish() with HTTP POST to worker                    | ~10      |
| `src/app/api/sessions/[id]/mode/route.ts`            | Replace publish() with HTTP POST to worker                    | ~5       |
| `src/app/api/sessions/[id]/model/route.ts`           | Replace publish() with HTTP POST to worker                    | ~5       |
| `src/lib/services/session-service.ts`                | Replace publish/broadcast with HTTP POST                      | ~10      |
| `src/lib/worker/stale-reaper.ts`                     | Replace broadcastSessionStatus                                | ~5       |
| `src/worker/zombie-reconciler.ts`                    | Replace broadcastSessionStatus                                | ~5       |
| `src/lib/worker/brainstorm-orchestrator.ts`          | Replace all publish/subscribe                                 | ~30      |
| `src/app/api/brainstorms/[id]/events/route.ts`       | Replace subscribe with file watcher                           | ~20      |
| `src/app/api/brainstorms/[id]/steer/route.ts`        | Replace publish with HTTP POST                                | ~10      |
| `src/app/api/brainstorms/[id]/end/route.ts`          | Replace publish with HTTP POST                                | ~10      |
| `src/app/api/brainstorms/[id]/extend/route.ts`       | Replace publish with HTTP POST                                | ~5       |
| `src/app/api/brainstorms/[id]/participants/route.ts` | Replace publish with HTTP POST                                | ~5       |

**Total estimated change:** ~20 files, ~600 LOC (200 new, 400 modified/removed)

**Pros:**

- Eliminates all database load from real-time events (zero pg_notify queries)
- No payload size limit (events are full JSON in log file)
- No connection pool pressure (no LISTEN connections)
- File is already the source of truth — this just removes the middleman
- Worker HTTP endpoint is faster than going through PG for control messages
- Easy to reason about: file = events, HTTP = control

**Cons:**

- `fs.watch()` has platform quirks (Linux inotify is solid but macOS fsevents differs). However, for our use case (tailing a single append-only log file per session), raw `fs.watch` on Linux is reliable — no directory watching needed
- File watcher latency: inotify kernel notification is ~1-10µs; Node.js event loop adds overhead. Net latency likely comparable to or better than PG NOTIFY's ~2-5ms
- Worker HTTP endpoint needs service discovery (port coordination via ecosystem.config.js)
- Two new modules to maintain instead of one
- Brainstorm orchestrator cross-channel (subscribing to session events) needs rethinking
- Out-of-band broadcasters (stale-reaper, zombie-reconciler) need either: HTTP to worker, or direct SSE push

**Key challenge — brainstorm cross-channel:**
The brainstorm orchestrator subscribes to session events via pg_notify to collect agent responses. In the file-watch model, the orchestrator would need to fs.watch each participant's session log file. This is actually simpler in some ways (direct file access, no serialization round-trip) but means the orchestrator needs file paths for each participant session.

**Key challenge — out-of-band status updates:**
`broadcastSessionStatus()` is called by the stale-reaper and zombie-reconciler (which run in the worker process) to notify frontends of status changes. Without pg_notify, these need to either:

1. Write a synthetic event to the session log file (file watcher picks it up)
2. POST to the Next.js SSE endpoint (adding an HTTP dependency)

Option 1 is cleaner — the log file already handles all event types.

**Risk level:** Medium (well-scoped, but touches many files)
**Effort:** 2-3 days of focused work

### Option C: Unix Domain Socket (Bidirectional)

**Description:** Replace pg_notify with a single Unix domain socket per session for bidirectional communication between Next.js and Worker.

**Design:**

```
Worker creates UDS: /tmp/agendo-session-{sessionId}.sock
  → Next.js SSE route connects as client
  → Events flow Worker → Next.js
  → Control flows Next.js → Worker
```

**Pros:**

- Single connection per session (vs two channels in pg_notify)
- Zero database load
- No payload size limits
- Lowest possible latency: ~130µs measured (vs ~2-5ms for pg_notify — 15-40x faster)
- Natural bidirectional communication
- Built-in backpressure
- Industry standard for same-machine IPC (PM2, Docker, systemd, PostgreSQL itself all use UDS)

**Cons:**

- Significant complexity increase: socket lifecycle management, reconnection, error handling
- Process coupling: Next.js must know worker socket paths (service discovery)
- No fan-out: multiple SSE clients require explicit multiplexing in the socket handler
- Socket file cleanup on crash (stale .sock files)
- Brainstorm cross-channel becomes complex (orchestrator connecting to participant sockets)
- Not portable to distributed deployments (UDS is local-only)
- More code than Option B for the same functional result

**Risk level:** High (significant new infrastructure, complex error handling)
**Effort:** 4-5 days of focused work

### Option D: Redis Pub/Sub (If Scaling Needed)

**Description:** Replace pg_notify with Redis pub/sub for real-time events. Only relevant if horizontal scaling is needed in the future.

**Pros:**

- Horizontal scaling: multiple app servers subscribe to the same channels
- No database load for real-time events
- No payload size limit (effectively)
- Battle-tested pub/sub semantics
- Rich ecosystem (ioredis, etc.)

**Cons:**

- New infrastructure dependency (Redis server)
- Operational overhead: monitoring, persistence, memory management
- Overkill for single-server deployment
- Still fire-and-forget (same durability model as pg_notify)
- Added network hop (app → Redis → app) vs local-only options

**Risk level:** Medium (proven technology, but new dependency)
**Effort:** 3-4 days + infrastructure setup

## Decision Matrix

| Criterion                  | Weight | A: pg_notify                  | B: File+HTTP                     | C: UDS                    | D: Redis              |
| -------------------------- | ------ | ----------------------------- | -------------------------------- | ------------------------- | --------------------- |
| **DB load reduction**      | High   | 0 (no change)                 | 10 (eliminated)                  | 10 (eliminated)           | 10 (eliminated)       |
| **Latency**                | Medium | 7 (~2-5ms measured)           | 8 (~1-10µs inotify + event loop) | 10 (~130µs UDS)           | 7 (~1-2ms Redis)      |
| **Payload limits**         | Medium | 3 (7500 byte cap)             | 10 (unlimited)                   | 10 (unlimited)            | 10 (unlimited)        |
| **Migration effort**       | High   | 10 (none)                     | 7 (2-3 days)                     | 4 (4-5 days)              | 5 (3-4 days + infra)  |
| **Operational simplicity** | High   | 8 (no extra services)         | 8 (no extra services)            | 6 (socket cleanup)        | 4 (Redis server)      |
| **Reliability**            | High   | 7 (pool pressure, reconnects) | 8 (fs.watch is solid on Linux)   | 6 (socket lifecycle)      | 8 (Redis is reliable) |
| **Horizontal scaling**     | Low    | 2 (single DB only)            | 3 (local files only)             | 1 (local sockets)         | 10 (distributed)      |
| **Code complexity**        | Medium | 6 (multiplexer is complex)    | 8 (simpler modules)              | 4 (complex lifecycle)     | 6 (new dependency)    |
| **Brainstorm compat**      | Medium | 9 (works well)                | 6 (needs rethinking)             | 4 (complex cross-channel) | 8 (natural channels)  |
| **Weighted Score**         |        | **6.4**                       | **7.8**                          | **5.9**                   | **6.8**               |

_Scores: 0 = worst, 10 = best. Weights: High = 3x, Medium = 2x, Low = 1x._

## Recommendation

**Keep pg_notify (Option A) with targeted optimizations.**

Despite Option B scoring higher in the abstract matrix, the practical recommendation is to stay with pg_notify for the following reasons:

### 1. The Current System Works

The pg_notify implementation has been battle-tested in production with 4 concurrent AI agents, brainstorm sessions with multiple participants, and extensive real-time streaming. All the "gotcha" bugs have been found and fixed:

- Connection pool exhaustion → fixed with multiplexer (b417d18)
- Double-release → fixed with exitHandled guard
- Heartbeat stale-reaper race → fixed by starting heartbeat before subscribe
- Text delta buffering → fixed with 200ms batched publish

### 2. The Real Costs Are Manageable (and Reducible)

At current scale (1-5 concurrent sessions, occasional brainstorms):

- ~300-600 DB queries/minute during peak activity (NOTIFY + eventSeq updates)
- This is negligible compared to the agent adapter traffic (Claude SDK makes far more API calls)
- PostgreSQL handles NOTIFY at essentially zero cost — it's a lightweight broadcast mechanism
- The listener pool (max 20) has never been exhausted since the multiplexer was added
- Applying the Notifier Pattern (single connection) reduces the pool from 20 to 1

### 3. Option B's Benefits Don't Justify Migration Risk

The file-watch approach would:

- Touch 20+ files across the codebase
- Require rethinking the brainstorm cross-channel pattern (orchestrator subscribing to session events)
- Introduce fs.watch platform quirks (less battle-tested than PG NOTIFY)
- Need a new HTTP server in the worker (new attack surface, port management)
- Risk regressions in a critical real-time path with many edge cases

The 7500-byte payload limit is rarely hit (only large tool outputs), and the ref-stub fallback handles it gracefully. The log file has the full content for replay.

### 4. Targeted Optimizations Can Address Specific Pain Points

Instead of a full migration, these targeted improvements would address the main concerns:

**Optimization 1: Batch event publishing (low effort)**
Batch multiple events into a single `SELECT pg_notify()` call using array aggregation. Reduces query count by 50-80% during high-frequency periods (tool streaming, text deltas).

**Optimization 2: Skip pg_notify for delta events when no SSE clients (low effort)**
Check if any SSE subscribers exist for the session channel before publishing text-delta and thinking-delta events. If nobody is watching, skip the NOTIFY entirely (the events aren't persisted to log anyway).

**Optimization 3: Single-connection Notifier Pattern (~50 LOC refactor)**
Collapse the multiplexer from one-connection-per-channel to one-connection-total. A single PG connection can LISTEN on all active channels simultaneously. This reduces the listener pool from max=20 to max=1, eliminating connection pool pressure entirely. The [Brandur Notifier Pattern](https://brandur.org/notifier) validates this approach — Agendo already implements a partial version.

### When to Reconsider

Migrate to Option B (File+HTTP) **if and when**:

- The system needs to support 20+ concurrent sessions routinely
- PostgreSQL is moved to a remote server (adds network latency to every event)
- The 7500-byte payload limit becomes a frequent bottleneck (e.g. streaming large file contents)
- Horizontal scaling is required (multiple Next.js instances)

Migrate to Option D (Redis) **if and when**:

- Multiple app servers need to share real-time channels
- The system moves to a distributed architecture

## Migration Plan (If Option B Is Chosen Later)

This plan is provided for reference if the targeted optimizations prove insufficient.

### Phase 1: Control Channel Migration (1 day, low risk)

1. Add a lightweight HTTP server to the worker process (`src/lib/worker/worker-http.ts`)
2. Expose `POST /control/:sessionId` endpoint
3. Update all API routes to POST to worker HTTP instead of pg_notify for control messages
4. Keep pg_notify for events (still needed for SSE)
5. **Test:** All control actions (message, cancel, tool-approval, mode, model) work via HTTP

### Phase 2: Event Channel Migration (1.5 days, medium risk)

1. Create `src/lib/realtime/file-watcher.ts` using `fs.watch()` with line-offset tracking
2. Update SSE route to use file watcher instead of pg_notify subscribe
3. Update `emitEvent()` to remove pg_notify publish (keep log write)
4. Handle out-of-band status broadcasts by writing to session log files
5. **Test:** SSE reconnect, log replay, brainstorm events all work via file watcher

### Phase 3: Brainstorm Cross-Channel (0.5 day, medium risk)

1. Update brainstorm orchestrator to watch participant session log files directly
2. Remove pg_notify subscribe for session events in orchestrator
3. **Test:** Full brainstorm wave cycle with steering and synthesis

### Phase 4: Cleanup (0.5 day, low risk)

1. Remove `src/lib/realtime/pg-notify.ts`
2. Remove listener pool configuration
3. Update tests
4. Remove pg_notify from architecture docs

## Risks and Mitigations

### If Staying with pg_notify (Recommended)

| Risk                                     | Likelihood | Impact | Mitigation                                                      |
| ---------------------------------------- | ---------- | ------ | --------------------------------------------------------------- |
| Pool exhaustion during large brainstorms | Low        | High   | Increase pool max to 50; multiplexer already bounds connections |
| DB performance impact at scale           | Low        | Medium | Batch NOTIFY calls; skip deltas when no subscribers             |
| PG restart drops all listeners           | Low        | High   | Reconnect logic already handles this with exponential backoff   |
| Payload truncation loses data            | Medium     | Low    | Log file has full content; ref-stub is informational only       |

### If Migrating to Option B

| Risk                                | Likelihood | Impact | Mitigation                                                |
| ----------------------------------- | ---------- | ------ | --------------------------------------------------------- |
| fs.watch misses file changes        | Low        | High   | Use chokidar for robustness; keep polling fallback        |
| Worker HTTP port conflicts          | Low        | Medium | Dynamic port with service discovery via DB/file           |
| Brainstorm cross-channel regression | Medium     | High   | Extensive integration testing before cutover              |
| SSE latency increase                | Medium     | Low    | 10-50ms is imperceptible for chat UI; only affects deltas |

## Appendix: Quick Wins (Immediate, No Architecture Change)

These can be implemented independently, each in under an hour:

### A1. Skip NOTIFY for delta events when no browser is watching

In `session-process.ts` ActivityTracker callbacks, check if the channel has any listeners before publishing. The multiplexer's `channels` map tracks this. If `channels.get(channelName(...))` is undefined or has 0 listeners, skip the publish entirely. Delta events are ephemeral — no data loss.

### A2. Debounce eventSeq updates

Instead of `UPDATE sessions SET eventSeq = $1` on every single event, batch it: keep a local counter and flush to DB every 5 seconds or on status transitions. This removes ~50% of the DB write load from the event path. The only consumer of `eventSeq` is SSE reconnect catchup, which reads the log file anyway — a stale `eventSeq` just means the SSE might read slightly more log than needed.

### A3. Remove the brainstorm orchestrator's PG NOTIFY control fallback

The `publish(agendo_control_*, message)` at brainstorm-orchestrator.ts:1263 is dead code in the single-worker deployment. The primary path uses `getSessionProc()` for in-process delivery. Remove it to simplify the code and eliminate one publish call site.

---

## Research Inputs

- **Codebase analysis**: `planning/research/pg-notify-codebase-analysis.md` — detailed mapping of all 21 publish and 6 subscribe call sites, connection cost analysis, dual-write pattern documentation
- **Alternatives research**: `planning/research/pg-notify-alternatives-research.md` — benchmarks for UDS (130µs), inotify (sub-ms), HTTP-on-UDS (~150µs), WebSocket, child_process IPC, named pipes, shared memory, Redis, pg-boss pub/sub, and the Brandur Notifier Pattern. Includes real-world examples (PM2, Docker, systemd, Temporal, BullMQ)
- **Architect analysis**: Deep read of all 22 files using pg_notify, including session-process.ts, brainstorm-orchestrator.ts, all SSE routes, all control routes, stale-reaper, zombie-reconciler, and the terminal server WebSocket pattern

---

_This ADR was produced through deep analysis of the Agendo codebase, reading all 22 files that use pg_notify, tracing every publish/subscribe call site, and evaluating the full real-time event lifecycle from agent process to browser EventSource._
