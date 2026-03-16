# Terminal Pattern Analysis: Reference Architecture for Real-Time Simplification

**Date**: 2026-03-16
**Scope**: Analyze `src/terminal/server.ts` as a reference for simplifying session event delivery.

---

## 1. Terminal Server — How It Works

### File: `src/terminal/server.ts` (~267 LoC total)

**Structure (very simple):**

```
http.createServer() → health check only
WebSocketServer on same httpServer
  → on('connection'): auth, find/create SessionEntry, replay scrollback, add viewer
  → on('message', binary): write to pty (terminal input)
  → on('message', text/JSON): handle resize
  → on('close'): remove viewer, kill PTY if no viewers remain
pty.onData → appendScrollback + broadcastData to all viewers
```

**Auth**: JWT token in WebSocket URL query string (`?token=...`). Verified synchronously before the connection is accepted. Token payload carries `sessionName`, `mode`, `cwd`, `initialHint`.

**Multi-session**: `Map<string, SessionEntry>`. Each entry holds `{ tmuxName, ptyProcess, viewers: Set<WebSocket>, scrollback: string }`. Multiple viewers can share the same PTY.

**Scrollback/replay**: Ring buffer (50 KB). On reconnect, the full scrollback is immediately replayed as raw bytes to the new WebSocket. No concept of event IDs.

**Reconnect**: Transparent. If the PTY session is still alive in the map, the new WebSocket just gets added to `viewers` and receives the scrollback replay. No special logic needed.

**Total complexity**: ~267 LoC, zero dependencies beyond `ws`, `node-pty`, and internal JWT helpers. It's the entire server in one file.

---

## 2. Current Session Events Architecture

### Data Flow (4-hop chain)

```
Worker (session-process.ts)
  emitEvent() → pg_notify('agendo_events_{sessionId}', event)
    → Next.js pg-notify multiplexer (pg-notify.ts)
      → subscribes one PG connection per channel
        → SSE route (events/route.ts)
          → ReadableStream → browser EventSource
```

**Control direction** (also 4 hops but reverse):

```
Browser → POST /api/sessions/{id}/message (or /control)
  → Next.js route validates, calls publish()
    → pg_notify('agendo_control_{sessionId}', payload)
      → Worker session-process.ts subscribes → pipes to agent stdin
```

### Key complexity points:

- **pg-notify.ts** (232 LoC): Full multiplexer with channel slots, heartbeat timers, exponential backoff reconnect, dead-slot cleanup. Non-trivial.
- **events/route.ts** (135 LoC): SSE stream setup, log file catchup replay (reads from disk), subscribe/unsubscribe lifecycle, `Last-Event-ID` reconnect support.
- **7500-byte truncation**: PG NOTIFY has an 8KB payload limit. Large events are replaced with `{type:'ref'}` stubs, requiring the client to re-fetch from the log file.
- **Two databases hops per event**: Worker `pg_notify` → PG → Next.js LISTEN → SSE → browser.
- **message/route.ts** (77 LoC): Cold-resume (re-enqueue job) vs hot-path (pg_notify). Handles image attachments.
- **control/route.ts** (143 LoC): Tool approvals, ExitPlanMode restart, steer/rollback — each with idle/active branching logic.

---

## 3. Question Analysis

### Q1: Can the Worker Serve SSE or WebSocket Directly?

**Yes, easily.** The Worker already runs as a long-lived Node.js process. Adding `http.createServer()` + a WebSocket server (like the terminal does) requires about 30 lines. The terminal server is the proof.

**Port**: Worker would need a new port, e.g. 4102. CORS would need `Access-Control-Allow-Origin` for the Next.js origin (4100). This is trivial to add.

**SSE vs WebSocket for session events**: WebSocket is strictly better here because:

- Session control (messages, tool approvals) also needs to flow browser→worker
- If we collapse both to a single WS connection per session, we eliminate all the `POST /api/sessions/[id]/message` and `/control` routes
- The terminal already proves WS handles bidirectional fine
- SSE would need a second channel for control, or still go through Next.js for writes

**Event replay / catchup**: The terminal uses a raw byte scrollback buffer. For sessions we need structured event replay by sequence ID. The log file (`session.logFilePath`) already stores all events. The Worker process knows the log file path for each active session, so it can replay directly from disk on reconnect — no Next.js involvement needed.

**What breaks**: The MCP server (`dist/mcp-server.js`) calls `AGENDO_URL` (the Next.js app) for task management. This is fine — MCP doesn't touch session events.

### Q2: Should We Merge Terminal Server into the Worker?

**Probably not.** The case for merging:

- One fewer PM2 process to manage
- Both manage real-time sessions
- Shared JWT verification code

The case against:

- Terminal server is deliberately isolated (restart drops terminals, not agent sessions)
- Terminal has `max_memory_restart: 512M` — memory budget separate from the worker
- Terminal depends on `node-pty` (native binary). Worker builds with esbuild and externals are carefully managed. Mixing them adds fragile native dependency handling to the worker build.
- Separation of concerns: terminal restarts are "safe", worker restarts are "dangerous". Merging makes the blast radius of a worker restart also kill all open terminals.

**Verdict**: Keep them separate but use the terminal's pattern in the worker.

### Q3: Can Control Messages Go Directly to the Worker?

**Yes.** If the Worker exposes a WebSocket server:

- Browser connects to `ws://host:4102/sessions/{id}?token=...`
- Events flow down (worker → browser) as JSON frames
- Control flows up (browser → worker) as JSON frames: `{ type: 'message', text }`, `{ type: 'tool-approval', ... }`, etc.
- No PG NOTIFY needed for the hot path

The current `agendo_control_*` PG NOTIFY channel is only needed because Next.js and the Worker are separate processes. With direct WS, that channel disappears entirely.

The `agendo_events_*` PG NOTIFY channel is also only a bridge between Worker and Next.js SSE. With direct WS, it also disappears.

**What still needs PG NOTIFY**:

- `broadcastSessionStatus()` — called by the stale reaper and zombie reconciler (which run in the Worker already, so they could just update a local in-memory map instead)
- The brainstorm orchestrator uses separate channels — unaffected

**Result**: PG NOTIFY could be reduced to brainstorm channels only, or eliminated entirely for session events.

### Q4: What Stays in Next.js?

With a Worker WebSocket server handling session events and control:

**Next.js keeps:**

- Page rendering (React SSR, all UI)
- All CRUD API routes: `GET/POST /api/sessions`, `GET/POST /api/tasks`, agents, projects, capabilities, etc.
- `POST /api/sessions` — session creation + pg-boss enqueue
- `POST /api/sessions/{id}/cancel` — cancel with DB update + WS notify
- Auth (JWT issuance/verification for UI login)
- MCP server hosting (the stdio transport, currently in the Next.js process)
- Push notifications (VAPID)
- Brainstorm API + SSE

**Next.js removes (migrated to Worker WS):**

- `GET /api/sessions/{id}/events` (SSE route)
- `POST /api/sessions/{id}/message` (hot path only; cold-resume stays in Next.js or moves to Worker)
- `POST /api/sessions/{id}/control` (most of it; the clearContextRestart DB logic could stay in Next.js)

**Net**: Next.js becomes thinner on the real-time layer but keeps all CRUD and rendering. The Worker becomes the session real-time hub.

### Q5: SSE vs WebSocket for Session Events

|                  | SSE (current)                          | WebSocket (proposed)              |
| ---------------- | -------------------------------------- | --------------------------------- |
| Browser support  | Native `EventSource`                   | Native `WebSocket`                |
| Directionality   | One-way (server→browser)               | Bidirectional                     |
| Reconnect        | Built-in with `Last-Event-ID`          | Manual (need to re-send position) |
| Event sequencing | Built-in `id:` field                   | Must be added to payload          |
| Overhead         | HTTP/1.1, chunked                      | WS framing (slightly lower)       |
| Proxy/firewall   | Works everywhere                       | Some enterprise proxies block     |
| CORS             | Standard `Access-Control-Allow-Origin` | Same                              |
| Control channel  | Needs separate POST route              | Same connection, send frame       |

**Winner for this use case: WebSocket.** The bidirectionality eliminates the need for separate control POST routes. The `Last-Event-ID` auto-reconnect of SSE is nice but easy to replicate (send `{ type: 'resume', afterSeq: N }` on connect). The terminal proves WebSocket is the right model when you need both event streaming and control.

---

## 4. Proposed Architecture

```
┌─────────────────────────────────────────────┐
│  Next.js App (port 4100)                    │
│  - React SSR, all page rendering            │
│  - CRUD APIs (sessions, tasks, agents, etc) │
│  - Auth (JWT issuance)                      │
│  - MCP server (stdio transport)             │
│  - Brainstorm SSE (unchanged)               │
│  - Session creation → pg-boss enqueue       │
└───────────────────────┬─────────────────────┘
                        │ pg-boss (job queue only)
┌───────────────────────▼─────────────────────┐
│  Worker (port 4100 + NEW port 4102)         │
│  - pg-boss job consumer (unchanged)         │
│  - Session runner, adapter factory          │
│  - NEW: WebSocket server (port 4102)        │
│    • JWT auth (same secret)                 │
│    • Map<sessionId, SessionEntry>           │
│      { proc: SessionProcess,                │
│        viewers: Set<WebSocket>,             │
│        eventBuffer: AgendoEvent[]           │
│      }                                      │
│    • Events DOWN: JSON frames to viewers    │
│    • Control UP: JSON frames from browser   │
│    • Replay: read log file on connect       │
└─────────────────────────────────────────────┘
```

**PG NOTIFY usage drops to:**

- `broadcastSessionStatus()` from zombie-reconciler / stale-reaper (both already IN the worker — could be in-memory instead)
- Brainstorm channels (unchanged)
- `agendo_events_*` and `agendo_control_*` channels eliminated entirely

**Removed files/routes:**

- `src/lib/realtime/pg-notify.ts` (or keep greatly simplified)
- `src/app/api/sessions/[id]/events/route.ts`
- Hot path from `src/app/api/sessions/[id]/message/route.ts`
- Most of `src/app/api/sessions/[id]/control/route.ts`

---

## 5. Migration Complexity Estimate

| Component                                                     | Effort                                                    | Risk   |
| ------------------------------------------------------------- | --------------------------------------------------------- | ------ |
| Add WS server to Worker (`src/worker/ws-server.ts`)           | Low (~200 LoC, mirrors terminal pattern)                  | Low    |
| Connect `SessionProcess.emitEvent()` to WS broadcast          | Low (add fanout in emitEvent)                             | Low    |
| Connect WS frames to `session-process.ts` control handler     | Low (replace pg_notify subscribe with WS message handler) | Low    |
| Log-file replay on WS connect                                 | Low (already done in SSE route, just move it)             | Low    |
| Update browser hooks (`use-session-stream.ts`) from SSE to WS | Medium (EventSource → WebSocket, reconnect logic)         | Medium |
| Cold-resume path (idle/ended sessions)                        | Medium (needs to forward to Next.js REST or Worker REST)  | Medium |
| Remove pg-notify multiplexer                                  | Medium (validate brainstorm still works)                  | Low    |
| CORS configuration for port 4102                              | Trivial                                                   | Low    |

**Total**: Roughly equivalent scope to the terminal server implementation, plus frontend hook changes.

---

## 6. Recommendation

**Yes, adopt the terminal pattern for session events.** Here's why:

1. **The terminal is proof it works.** Same host, same auth, different port. Already in production.

2. **PG NOTIFY was added to bridge two processes.** It was never the ideal architecture — it was the pragmatic solution when the Worker and Next.js needed to communicate without a direct channel. The terminal never needed it because the terminal server IS the process that runs the PTY.

3. **The 7500-byte truncation issue goes away.** WebSocket frames have no practical payload limit. Large events (e.g. full file contents in tool results) no longer get truncated to `{type:'ref'}` stubs.

4. **Fewer moving parts.** Eliminating `pg-notify.ts`, the SSE route, the listener pool, heartbeat timers, and backoff reconnect logic reduces the surface area for bugs significantly.

5. **Bidirectional simplicity.** One WebSocket connection per session replaces: SSE connection + POST /message + POST /control.

6. **The terminal pattern already handles the hard parts**: multi-viewer fan-out, scrollback replay, JWT auth, graceful shutdown. We adapt those patterns, not invent them.

**First step**: Add `src/worker/session-ws-server.ts` (mirrors terminal server structure) that the Worker entry point starts alongside the pg-boss listener. Wire `SessionProcess.emitEvent()` to broadcast to connected WebSocket viewers. This can ship alongside the existing SSE flow and the browser can be migrated incrementally.
