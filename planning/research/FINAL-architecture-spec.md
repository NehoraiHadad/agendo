# Agendo Real-Time Architecture — Final Spec

**Date**: 2026-03-16
**Status**: DEFINITIVE — this is the implementation plan
**Author**: Architect (synthesis of 11 research documents + full codebase analysis)

---

## Design Principles

1. **Log file is the event store** — not PG NOTIFY, not CLI native storage. Every AgendoEvent is written to the session log file. The log file is the single source of truth for replay.
2. **Worker serves events directly** — the Worker already owns session processes. It will also serve SSE and accept control messages over HTTP. No PG NOTIFY middleman.
3. **Terminal pattern as reference** — the terminal server (port 4101) proves the pattern: a standalone HTTP/WS server, JWT auth, browser connects directly, scrollback replay on reconnect. Session events follow this exact pattern.
4. **CLI-native replay for resume only** — Claude's JSONL, Codex's `thread/resume`, Gemini's `session/load` are used to restore agent context on cold-resume. Agendo's log file is used for browser replay.
5. **KISS over DRY** — no extra services, no new dependencies, no Redis, no UDS. Just HTTP and files.
6. **Three PM2 processes** — Next.js (UI + DB API), Worker (sessions + events HTTP), Terminal (pty + WS). This is the final topology.

---

## Process Topology

```
┌─────────────────────────────────────────────┐
│  Next.js App (port 4100)                    │
│  - UI (React Server Components + client)    │
│  - DB API routes (/api/tasks, /api/agents)  │
│  - MCP server (stdio, injected into agents) │
│  - Proxies to Worker for session APIs       │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  Worker (port 4102)  ← NEW: HTTP server     │
│  - pg-boss job consumer (run-session, etc.) │
│  - Spawns AI CLI subprocesses               │
│  - SSE endpoint: /sessions/:id/events       │
│  - Control endpoints: /sessions/:id/message │
│  - POST /sessions/:id/events (synthetic)    │
│  - Brainstorm events + control              │
│  - Stale reaper, zombie reconciler          │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  Terminal Server (port 4101)                │
│  - WebSocket: xterm.js + node-pty + tmux    │
│  - JWT auth in query string                 │
│  - Scrollback replay on reconnect           │
└─────────────────────────────────────────────┘
```

**PM2 config changes**: Add `WORKER_HTTP_PORT: 4102` to the worker env in `ecosystem.config.js`. No new PM2 entries.

---

## Connection Flow

### Browser → Session Events (live streaming)

```
Browser
  → EventSource(http://host:4100/api/sessions/:id/events?token=JWT)
  → Next.js proxies to Worker: http://localhost:4102/sessions/:id/events
  → Worker SSE handler:
      1. Read session from DB (verify exists, get logFilePath)
      2. Read log file, filter events after lastEventId, send catchup
      3. Register in-memory listener on SessionProcess
      4. SessionProcess.emitEvent() → write to log + notify listeners
      5. Listener pushes to SSE stream
```

**Key decision: SSE proxy via Next.js rewrites.**

The browser connects to Next.js (port 4100) which proxies the SSE to the Worker (port 4102) via `next.config.ts` rewrites. This is chosen over direct browser-to-worker because:

- Single origin for the browser (no CORS, no port exposure)
- Next.js rewrites are a zero-code proxy — no route handler needed
- Worker port 4102 stays behind the firewall (localhost only)
- Same pattern as terminal server (port 4101), which is already proxied

The rewrite is a single line in `next.config.ts`:

```ts
{ source: '/api/sessions/:id/live', destination: 'http://localhost:4102/sessions/:id/events' }
```

**Alternatives considered and rejected**:

- _Direct browser → Worker:_ Exposes worker port, requires CORS config, splits auth.
- _WebSocket instead of SSE:_ Next.js rewrites cannot proxy WebSocket upgrades. SSE has built-in `Last-Event-ID` reconnect. Control direction is low-frequency (separate POST is fine). Industry standard for AI streaming is SSE (OpenAI, Anthropic, Continue.dev).
- _fetch()-based proxy in API route:_ Works but adds an unnecessary route handler when rewrites do the same thing for free.

### Browser → Session Control (messages, approvals)

```
Browser
  → POST /api/sessions/:id/message (to Next.js at 4100)
  → Next.js API route:
      1. Validate request, auth
      2. Forward to Worker: POST http://localhost:4102/sessions/:id/control
         Body: { type: 'message', text: '...' }
      3. Worker finds SessionProcess in liveSessionProcs map
      4. Dispatches to onControl()
      5. Returns 200 OK (or 404 if session not on this worker)
```

All control actions (message, cancel, interrupt, tool-approval, tool-result, set-model, set-permission-mode, steer, rollback, mcp-\*, rewind-files) use the same `POST /sessions/:id/control` worker endpoint.

### Browser → Session History (reconnect/open)

```
Browser EventSource reconnects with Last-Event-ID header
  → Same flow as "Session Events" above
  → Step 2 replays events from log file after lastEventId
  → Step 3 picks up live events
  → No gap, no data loss (log file is the durability layer)
```

This is IDENTICAL to the current behavior. The only change is replacing PG NOTIFY subscription (step 3) with an in-memory listener.

### Browser → Terminal

Unchanged. Browser connects via WebSocket to port 4101 with JWT token in query string. Terminal server manages tmux sessions, replays scrollback on reconnect.

### Browser → Next.js (UI, DB API)

Unchanged. Next.js serves the React UI and all non-session API routes (tasks, agents, projects, brainstorms CRUD). Only session event/control routes change to proxy to the Worker.

---

## What Gets Removed

| Component                                   | Current                                                         | After                                                  | Why                                                                         |
| ------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `src/lib/realtime/pg-notify.ts`             | 232 LOC — publish, subscribe, multiplexer, heartbeat, reconnect | **DELETED**                                            | Replaced by in-memory listeners + Worker HTTP                               |
| PG listener pool                            | max=20 dedicated connections                                    | **GONE**                                               | Zero PG connections for IPC                                                 |
| `SELECT pg_notify()` on every event         | 1 DB query per event                                            | **GONE**                                               | Events go directly to in-memory listeners                                   |
| `UPDATE sessions SET eventSeq` per event    | 1 DB write per event                                            | **Debounced** — flush every 5s or on status transition | Reduces ~50% of DB writes on hot path                                       |
| `channelName()`, `broadcastSessionStatus()` | Used across 12 files                                            | **GONE**                                               | Replaced by direct function calls or Worker HTTP                            |
| Brainstorm PG NOTIFY control fallback       | `publish(agendo_control_*, message)` at orchestrator line 1263  | **REMOVED**                                            | Dead code in single-worker deployment. Primary path uses `getSessionProc()` |
| 7500-byte payload truncation + ref-stub     | `publish()` truncates to fit PG NOTIFY limit                    | **GONE**                                               | No payload limit with in-memory listeners                                   |
| `agent:text-delta` via PG NOTIFY            | Published but not logged                                        | **Emitted via in-memory listener**                     | Same ephemeral semantics, no DB query                                       |

**NOT removed:**

- The log file — it stays as the event store and replay source
- The `eventSeq` column — kept but debounced (useful for "event count" display)
- pg-boss — stays for job scheduling (different concern from real-time IPC)
- The brainstorm event/control system — migrated to same Worker HTTP + in-memory pattern

---

## What Gets Added

### 1. Worker HTTP Server (`src/lib/worker/worker-http.ts`, ~120 LOC)

A lightweight `http.createServer()` on port 4102 (localhost only). Routes:

| Method | Path                                 | Purpose                                             |
| ------ | ------------------------------------ | --------------------------------------------------- |
| GET    | `/sessions/:id/events`               | SSE stream (catchup from log + live from in-memory) |
| POST   | `/sessions/:id/control`              | Control dispatch (message, cancel, approval, etc.)  |
| POST   | `/sessions/:id/events`               | Inject synthetic event (for team API)               |
| GET    | `/sessions/:id/events?lastEventId=N` | SSE reconnect with catchup                          |
| GET    | `/brainstorms/:id/events`            | Brainstorm SSE stream                               |
| POST   | `/brainstorms/:id/control`           | Brainstorm control dispatch                         |
| GET    | `/health`                            | Health check                                        |

Auth: JWT token in `Authorization: Bearer` header (same JWT_SECRET as Next.js). The Next.js proxy adds this automatically.

Implementation: bare `http.createServer` — no Express, no Fastify. The routes are simple string matching (< 10 routes). The terminal server proves this pattern works fine.

### 2. In-Memory Event Listeners (`SessionProcess` changes, ~40 LOC)

Replace PG NOTIFY publish with an in-memory listener set on `SessionProcess`:

```typescript
// In SessionProcess:
private eventListeners = new Set<(event: AgendoEvent) => void>();

addEventListener(cb: (event: AgendoEvent) => void): () => void {
  this.eventListeners.add(cb);
  return () => this.eventListeners.delete(cb);
}

private async emitEvent(partial: AgendoEventPayload): Promise<AgendoEvent> {
  const seq = ++this.eventSeq;
  this.debouncedSeqFlush(); // flush to DB every 5s, not per-event

  const event = { id: seq, sessionId: this.session.id, ts: Date.now(), ...partial } as AgendoEvent;

  // Notify in-memory listeners (SSE connections on this worker)
  for (const cb of this.eventListeners) cb(event);

  // Write to log file for replay
  if (this.logWriter) this.logWriter.write(serializeEvent(event), 'system');

  return event;
}
```

Cost per event: 0 DB queries + 1 file write. Down from 2 DB queries + 1 file write.

### 3. SSE Handler in Worker (`src/lib/worker/worker-sse.ts`, ~80 LOC)

The SSE endpoint on the Worker replaces the current `events/route.ts` SSE logic:

```typescript
function handleSessionSSE(req, res, sessionId, lastEventId) {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 1. Send current session state from DB
  sendSSE(res, makeSessionStateEvent(session));

  // 2. Catchup from log file
  const catchupEvents = readEventsFromLog(logContent, lastEventId);
  for (const ev of catchupEvents) sendSSE(res, ev);

  // 3. Subscribe to live events
  const proc = getAnySessionProc(sessionId); // liveSessionProcs or allSessionProcs
  if (proc) {
    const unsub = proc.addEventListener((ev) => sendSSE(res, ev));
    req.on('close', unsub);
  }

  // 4. If session ended and no proc, just keep connection open for status updates
  // (stale-reaper/zombie-reconciler write synthetic events to log file)
}
```

### 4. Next.js Rewrite Proxy (`next.config.ts`, ~10 LOC)

Replace the current 135-line SSE route with a zero-code rewrite proxy:

```typescript
// next.config.ts
async rewrites() {
  return [
    {
      source: '/api/sessions/:id/live',
      destination: `http://localhost:${process.env.WORKER_HTTP_PORT || 4102}/sessions/:id/events`,
    },
    {
      source: '/api/brainstorms/:id/live',
      destination: `http://localhost:${process.env.WORKER_HTTP_PORT || 4102}/brainstorms/:id/events`,
    },
  ];
}
```

The old `events/route.ts` GET handler is deleted. The frontend changes `EventSource` URL from `/api/sessions/:id/events` to `/api/sessions/:id/live`.

Auth in the Worker SSE handler: validate JWT from the cookie or query param (same JWT_SECRET shared between Next.js and Worker). The rewrite forwards all headers including cookies.

### 5. Control Proxy in Next.js API Routes (~5 LOC per route)

Each control-publishing API route replaces `publish(channelName(...))` with:

```typescript
await fetch(`http://localhost:${WORKER_HTTP_PORT}/sessions/${id}/control`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT_SECRET}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
```

Extract this into a shared helper: `src/lib/realtime/worker-client.ts` (~30 LOC).

### 6. Out-of-Band Status Updates

Stale-reaper and zombie-reconciler currently call `broadcastSessionStatus()` which publishes via PG NOTIFY. These run IN the Worker process, so they can directly:

1. Find the `SessionProcess` in `allSessionProcs` and call `emitEvent()` on it, OR
2. Write a synthetic event to the session's log file (the SSE tailer picks it up)

Option 1 is cleaner since the SessionProcess manages listeners. For sessions without a live SessionProcess (orphan cleanup), write to the log file.

---

## Migration Plan

### Phase 1: Worker HTTP Server + Control Channel (1-2 days, low risk)

**Goal**: Replace PG NOTIFY for the control direction (Frontend → Worker).

1. Create `src/lib/worker/worker-http.ts` — HTTP server on port 4102
2. Create `src/lib/realtime/worker-client.ts` — `sendControl(sessionId, payload)` helper
3. Start the HTTP server in `src/worker/index.ts` (call `startWorkerHttp()` after `registerSessionWorker`)
4. Update all API routes that publish to `agendo_control_*`:
   - `sessions/[id]/message/route.ts`
   - `sessions/[id]/control/route.ts`
   - `sessions/[id]/mode/route.ts`
   - `sessions/[id]/model/route.ts`
   - `session-service.ts` (cancel, interrupt)
5. Update brainstorm control routes:
   - `brainstorms/[id]/steer/route.ts`
   - `brainstorms/[id]/end/route.ts`
   - `brainstorms/[id]/extend/route.ts`
   - `brainstorms/[id]/participants/route.ts`
6. Worker HTTP handler dispatches to `onControl()` via `liveSessionProcs.get(id)` or `allSessionProcs.get(id)`
7. Remove `subscribe(channelName('agendo_control', ...))` from `session-process.ts`
8. Remove brainstorm orchestrator's PG NOTIFY control fallback (line 1263)
9. Add `WORKER_HTTP_PORT` to `ecosystem.config.js`

**Test**: All control actions work — send message, cancel, tool-approval, model switch, permission mode change, brainstorm steer/end/extend.

**Rollback**: Revert to PG NOTIFY publish/subscribe. The log file path is unchanged.

### Phase 2: In-Memory Event Listeners + Worker SSE (2-3 days, medium risk)

**Goal**: Replace PG NOTIFY for the event direction (Worker → Frontend).

1. Add `eventListeners` Set + `addEventListener()` to `SessionProcess`
2. Add debounced `eventSeq` flush (5s timer + flush on `transitionTo()`)
3. Remove `publish(channelName('agendo_events', ...))` from `emitEvent()`
4. Remove `publish()` for text-delta and thinking-delta (emit via listener instead)
5. Create `src/lib/worker/worker-sse.ts` — SSE handler that:
   - Reads log file for catchup
   - Subscribes to in-memory listener for live events
6. Add SSE route to Worker HTTP server
7. Add `rewrites()` to `next.config.ts` — proxy `/api/sessions/:id/live` → Worker
8. Update `use-session-stream.ts` — change EventSource URL to `/api/sessions/:id/live`
9. Delete GET handler from `events/route.ts` (keep POST handler, move to Worker HTTP)
10. Do the same for brainstorm events (`brainstorms/[id]/events/route.ts`)
11. Handle out-of-band broadcasters:
    - `stale-reaper.ts` — call `proc.emitEvent()` or write to log file
    - `zombie-reconciler.ts` — write to log file (no proc for orphans)

**Test**: SSE streaming works end-to-end — fresh connect, reconnect with catchup, text-delta streaming, brainstorm events. Test with multiple browser tabs open.

**Rollback**: Re-add PG NOTIFY publish calls, revert rewrite, change URL back. The log file is unchanged, so replay works regardless.

### Phase 3: Cleanup (0.5 day, low risk)

1. Delete `src/lib/realtime/pg-notify.ts`
2. Remove the dedicated listener pool (the `Pool({ max: 20 })` in pg-notify.ts)
3. Remove `channelName()` imports from all files
4. Update `src/lib/config.ts` if any pg-notify config exists
5. Update tests that mock pg-notify
6. Delete brainstorm PG NOTIFY subscriber in orchestrator (session event monitoring)
   - Replace with `proc.addEventListener()` (orchestrator has access via `getSessionProc()`)
7. Update CLAUDE.md architecture diagrams

---

## Files Changed

### New Files (4)

| File                                | LOC  | Purpose                                                  |
| ----------------------------------- | ---- | -------------------------------------------------------- |
| `src/lib/worker/worker-http.ts`     | ~120 | HTTP server on port 4102 (routes, auth, request parsing) |
| `src/lib/worker/worker-sse.ts`      | ~80  | SSE handler (catchup + live listener)                    |
| `src/lib/realtime/worker-client.ts` | ~30  | `sendControl()` helper for Next.js → Worker HTTP         |
| (none — no file-watcher.ts)         | —    | fs.watch is NOT used. In-memory listeners replace it.    |

### Modified Files (18)

| File                                                 | Change                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/worker/index.ts`                                | Add `startWorkerHttp()` call in `main()`, pass session proc maps                                                           |
| `src/lib/worker/session-process.ts`                  | Add `eventListeners` + `addEventListener()`, debounce eventSeq, remove `publish()` calls, remove `subscribe()` for control |
| `src/app/api/sessions/[id]/events/route.ts`          | DELETE GET handler (replaced by rewrite proxy). Keep POST handler (move to new route or Worker).                           |
| `next.config.ts`                                     | Add `rewrites()` for `/api/sessions/:id/live` and `/api/brainstorms/:id/live`                                              |
| `src/hooks/use-session-stream.ts`                    | Change EventSource URL from `/api/sessions/:id/events` to `/api/sessions/:id/live`                                         |
| `src/app/api/sessions/[id]/message/route.ts`         | Replace `publish()` with `sendControl()`                                                                                   |
| `src/app/api/sessions/[id]/control/route.ts`         | Replace `publish()` with `sendControl()`                                                                                   |
| `src/app/api/sessions/[id]/mode/route.ts`            | Replace `publish()` with `sendControl()`                                                                                   |
| `src/app/api/sessions/[id]/model/route.ts`           | Replace `publish()` with `sendControl()`                                                                                   |
| `src/lib/services/session-service.ts`                | Replace `publish()`/`broadcastSessionStatus()` with `sendControl()`                                                        |
| `src/lib/worker/stale-reaper.ts`                     | Replace `broadcastSessionStatus()` with direct `emitEvent()` or log write                                                  |
| `src/worker/zombie-reconciler.ts`                    | Replace `broadcastSessionStatus()` with log file write                                                                     |
| `src/lib/worker/brainstorm-orchestrator.ts`          | Replace all `publish()`/`subscribe()` with Worker HTTP + in-memory listeners                                               |
| `src/app/api/brainstorms/[id]/events/route.ts`       | Replace SSE logic with Worker proxy                                                                                        |
| `src/app/api/brainstorms/[id]/steer/route.ts`        | Replace `publish()` with `sendControl()`                                                                                   |
| `src/app/api/brainstorms/[id]/end/route.ts`          | Replace `publish()` with `sendControl()`                                                                                   |
| `src/app/api/brainstorms/[id]/extend/route.ts`       | Replace `publish()` with `sendControl()`                                                                                   |
| `src/app/api/brainstorms/[id]/participants/route.ts` | Replace `publish()` with `sendControl()`                                                                                   |
| `ecosystem.config.js` (example)                      | Add `WORKER_HTTP_PORT: 4102` to worker env                                                                                 |
| `CLAUDE.md`                                          | Update architecture diagrams, add Worker HTTP port to table                                                                |

### Deleted Files (2)

| File                                                      | LOC  | Reason                                   |
| --------------------------------------------------------- | ---- | ---------------------------------------- |
| `src/lib/realtime/pg-notify.ts`                           | -232 | Entire module replaced                   |
| `src/app/api/sessions/[id]/events/route.ts` (GET handler) | -105 | Replaced by Next.js rewrite → Worker SSE |

### Net Impact

- **New code**: ~230 LOC (4 new files)
- **Modified**: ~200 LOC changes across 18 files (most are simple `publish()` → `sendControl()` replacements)
- **Deleted**: ~250 LOC (pg-notify.ts + removed publish/subscribe calls)
- **Net**: ~20 fewer lines of code

---

## Risks

### Risk 1: Worker restart drops SSE connections

**Severity**: Medium
**Likelihood**: Expected (every deploy)

When the Worker restarts, all SSE connections drop. The browser's `EventSource` auto-reconnects with `Last-Event-ID`. The reconnect reads from the log file (which persists on disk), so no data is lost.

This is the SAME behavior as today — PG NOTIFY connections also drop on Worker restart, and the SSE endpoint in Next.js reconnects by reading the log file.

**Mitigation**: Already handled. `EventSource` auto-reconnects. Log file provides replay.

### Risk 2: Next.js SSE proxy adds latency

**Severity**: Low
**Likelihood**: Certain (proxy adds a hop)

The proxy adds one HTTP hop (Next.js → Worker on localhost). Latency: ~0.5-1ms per event. For a chat UI streaming at token-level speed (~50 tokens/sec), this is imperceptible.

**Mitigation**: None needed. If this ever matters, expose Worker port directly and connect browser to it.

### Risk 3: Worker HTTP port conflict

**Severity**: Low
**Likelihood**: Low

Port 4102 could conflict with another service.

**Mitigation**: Configure via `WORKER_HTTP_PORT` env var. Check on startup with `server.listen()` error handler.

### Risk 4: Brainstorm cross-channel regression

**Severity**: Medium
**Likelihood**: Medium

The brainstorm orchestrator subscribes to participant session events via PG NOTIFY to detect wave completion. Replacing this with in-memory listeners requires the orchestrator to get references to participant SessionProcess instances.

**Mitigation**: The orchestrator already uses `getSessionProc()` as the primary path (PG NOTIFY is the fallback). After this migration, `getSessionProc()` becomes the ONLY path, which is simpler. The orchestrator calls `proc.addEventListener()` to monitor participant sessions.

### Risk 5: Sessions not on this worker

**Severity**: Low
**Likelihood**: Very low (single-worker deployment)

If a future multi-worker deployment is added, the Worker HTTP endpoint returns 404 for sessions it doesn't own. The Next.js proxy would need to try other workers.

**Mitigation**: Not a concern for single-worker. For future multi-worker: add session→worker routing in DB, or keep PG NOTIFY as a broadcast fallback for the control direction only.

---

## Decisions Made (No Ambiguity)

1. **Worker gets an HTTP server on port 4102.** Not UDS, not WebSocket. HTTP is simple, debuggable with curl, and follows the terminal server pattern.

2. **Browser connects to Next.js, which proxies SSE to Worker.** Not direct-to-worker. Single origin, no CORS, worker stays behind firewall.

3. **In-memory listeners replace PG NOTIFY for events.** Not fs.watch. The Worker already owns the SessionProcess — an in-memory Set is the simplest possible notification mechanism. Zero latency, zero overhead, zero infrastructure.

4. **Worker HTTP replaces PG NOTIFY for control.** Not UDS, not WebSocket. HTTP POST with JSON body. Request/response semantics confirm delivery (unlike PG NOTIFY fire-and-forget).

5. **Log file stays as the event store.** Not eliminated, not replaced with CLI native storage. ~52% of AgendoEvent types are Agendo-generated with no CLI equivalent. The log file is the unified, enriched event stream.

6. **eventSeq UPDATE is debounced to every 5 seconds.** Not per-event, not eliminated. The local counter tracks the real value; DB is eventually consistent. SSE reconnect uses the log file (not eventSeq) for replay.

7. **Three PM2 processes stay.** Worker does NOT merge with Terminal. They have different concerns (AI sessions vs PTY terminals), different lifecycles, and different resource profiles. Merging adds complexity for no benefit.

8. **No fs.watch anywhere.** In-memory listeners are strictly better for our use case — the Worker already has the SessionProcess in memory. fs.watch adds file descriptor management, inotify edge cases, and cross-process concerns that don't exist with in-memory listeners.

9. **The brainstorm feature stays.** The user said it's "not used" but the code is heavily integrated (3 queue types, orchestrator, 4 API routes, SSE endpoint). Removing it is a separate task. This migration replaces its PG NOTIFY usage with the same Worker HTTP + in-memory pattern.

10. **No new dependencies.** `http.createServer()` is stdlib. No Express, no Fastify, no ws (for this). The terminal server proves bare `http.createServer` + manual routing works fine for < 10 routes.

---

## Appendix: Why NOT These Alternatives

### Why not fs.watch on log files?

The prior research recommends it. But it's unnecessary when the Worker already has the SessionProcess in memory. fs.watch would be needed if the SSE endpoint ran in a DIFFERENT process from the event emitter — which is the current situation (SSE in Next.js, events in Worker). But we're moving the SSE endpoint TO the Worker. Once SSE and events are in the same process, in-memory listeners are strictly simpler.

### Why not merge Worker and Next.js into one process?

Next.js needs to restart for deployments (code changes, UI updates). The Worker should NOT restart during active sessions — it kills agent processes. Keeping them separate means you can deploy UI changes without interrupting agents. The `safe-restart-agendo.sh` script already handles this separation.

### Why not WebSocket instead of SSE?

SSE is simpler, native `EventSource` in the browser, auto-reconnects with `Last-Event-ID`. WebSocket is bidirectional but we don't need that — the control direction is separate (POST requests). The terminal server uses WebSocket because it needs bidirectional binary streams. Session events are unidirectional text streams — SSE is the right tool.

### Why not expose Worker port directly to the browser?

CORS, auth duplication, port exposure. The Next.js proxy handles auth, keeps a single origin, and hides the worker topology. The cost (one HTTP hop on localhost) is negligible.
