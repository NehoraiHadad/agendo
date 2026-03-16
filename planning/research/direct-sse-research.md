# Direct SSE from Worker: Research

## Executive Summary

**Recommendation: Option 3 — Next.js rewrites proxy to Worker SSE on a dedicated port.**

This gives us a single external port (4100), eliminates PG NOTIFY as middleware for real-time events, keeps process isolation, and follows the exact same pattern as the terminal server (port 4101). The Worker already has all the session state — it should serve SSE directly.

---

## 1. Current Architecture (Status Quo)

```
Browser
  → EventSource GET /api/sessions/:id/events (port 4100, Next.js)
  → Next.js SSE route handler subscribes to PG NOTIFY
  → Worker publishes events via PG NOTIFY (7500 byte limit)
  → Next.js route handler pushes to browser via SSE

Control messages:
  → Browser POST /api/sessions/:id/messages (port 4100, Next.js)
  → Next.js publishes to PG NOTIFY control channel
  → Worker subscribes, pipes to agent stdin
```

### Problems with current approach

1. **PG NOTIFY is a bottleneck** — 7500 byte payload limit forces `{type:'ref'}` stubs for large events; clients must fetch full payloads separately.
2. **Double hop** — Worker → PG NOTIFY → Next.js → SSE → Browser. Every event traverses the database.
3. **Connection pool pressure** — Each SSE connection in Next.js needs a PG LISTEN connection (mitigated by the multiplexer, but still ~1 connection per distinct session channel).
4. **Next.js SSE is fragile** — Known buffering issues with compression, `Content-Encoding` headers, and `ReadableStream` in the App Router. Must set `Content-Encoding: none`, `X-Accel-Buffering: no`, etc.
5. **No direct relationship** — Next.js has no knowledge of the session process; it's just a dumb pipe between PG NOTIFY and the browser.

---

## 2. Online Research Findings

### 2.1 SSE from plain Node.js `http.createServer()`

SSE from a bare `http.createServer()` is trivial and battle-tested:

```js
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
});
res.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
```

No framework needed. Node's HTTP server handles keep-alive natively. The `EventSource` API in browsers handles reconnection via `Last-Event-ID` automatically.

**CORS considerations**: When SSE is on a different port (e.g., Worker on 4102, app on 4100), the browser treats it as cross-origin. Requires:

- Server: `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true`
- Client: `new EventSource(url, { withCredentials: true })`

However, **if we proxy through Next.js rewrites, CORS is not needed** — the browser sees the same origin (port 4100).

### 2.2 SSE vs WebSocket for this use case

| Aspect                     | SSE                                                  | WebSocket                                   |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| Direction                  | Server → Client only                                 | Bidirectional                               |
| Reconnection               | Built-in (`Last-Event-ID`)                           | Manual                                      |
| Infrastructure             | Standard HTTP, works with proxies/CDNs               | Needs upgrade, special proxy config         |
| Complexity                 | Minimal                                              | Protocol upgrade, heartbeats, sub-protocols |
| Industry trend (2025-2026) | "SSE's glorious comeback" — default for AI streaming | Reserved for true bidirectional needs       |

**For Agendo's session events**: SSE is the right choice. Events flow server→client (one-directional). Control messages (client→server) already use POST endpoints — this is the standard pattern (SSE down + fetch POST up).

**What the industry does**:

- OpenAI, Anthropic, Google: SSE for token streaming
- VS Code/Copilot: LSP over stdio (in-process extension host)
- Cursor: Streamable HTTP (SSE-like) for MCP, proprietary internal streaming
- Zed: Native Rust, direct memory sharing
- Continue.dev: SSE for agent streaming
- Codex `app-server`: NDJSON over stdio (same pattern as LSP)

The terminal server already uses WebSocket because terminal I/O is truly bidirectional (keystrokes up, output down). Session events are fundamentally different — unidirectional push.

### 2.3 Merging Worker + Next.js into one process?

**Not recommended:**

- PM2 process isolation is valuable — Worker crash doesn't take down the UI
- Worker spawns agent subprocesses (Claude, Codex, Gemini) that consume significant memory; isolating them prevents OOM from killing the web server
- Separate processes allow independent restarts (Worker restarts are safe; Next.js restarts kill MCP)
- On a 4-CPU/16GB server, process isolation provides natural resource boundaries

**Keep them separate.** The question is not "merge processes" but "where does the HTTP server for real-time live?"

### 2.4 Next.js as reverse proxy

Next.js `rewrites` in `next.config.ts` can proxy HTTP requests to a backend:

```ts
async rewrites() {
  return [
    {
      source: '/api/sessions/:id/live',
      destination: 'http://localhost:4102/sessions/:id/events',
    },
  ];
}
```

**Key findings**:

- Rewrites work for SSE (standard HTTP GET with streaming response)
- Rewrites do **NOT** work for WebSocket (no protocol upgrade support)
- For SSE proxy, need `X-Accel-Buffering: no` header on the upstream response
- Single port (4100) from the browser's perspective — no CORS issues

**This is the best of both worlds**: Worker serves SSE directly (no PG NOTIFY), browser connects through the familiar port 4100, no CORS headaches.

### 2.5 Real-world patterns

| Tool              | Backend → Frontend        | Protocol              | Notes                        |
| ----------------- | ------------------------- | --------------------- | ---------------------------- |
| VS Code + Copilot | Extension Host → Webview  | JSON-RPC over stdio   | In-process, not over network |
| Cursor            | Agent backend → Editor    | Streamable HTTP (SSE) | Proprietary, multi-agent     |
| Zed               | Rust backend → UI         | Direct memory         | No network boundary          |
| Continue.dev      | Python backend → IDE      | SSE                   | Standard pattern             |
| LangGraph         | Worker → Frontend         | SSE                   | FastAPI + SSE is standard    |
| Agendo Terminal   | terminal-server → Browser | WebSocket             | Bidirectional terminal I/O   |

**Pattern**: When there's a network boundary (backend process → browser), SSE is the standard for one-directional streaming. WebSocket only when bidirectional byte streams are needed (terminals, collaborative editing).

---

## 3. Codebase Analysis

### 3.1 Worker currently has no HTTP server

`src/worker/index.ts` is a pure job consumer:

- Registers pg-boss handlers (`handleSessionJob`, `handleBrainstormJob`)
- Runs heartbeats, stale reaper, zombie reconciler
- No `http.createServer()`, no port binding

Adding an HTTP server is straightforward — it's just another `createServer().listen()` call in `main()`.

### 3.2 Terminal server is the exact precedent

`src/terminal/server.ts` (port 4101) already demonstrates the pattern:

- Separate PM2 process (`agendo-terminal`)
- `createServer()` + WebSocketServer
- JWT auth via query param
- Health check endpoint
- Graceful shutdown

A Worker SSE server would follow the same structure but simpler (no PTY, no tmux, just SSE).

### 3.3 Worker already has all the state

The Worker's `session-process.ts` already:

- Owns the agent subprocess
- Parses all events from the agent
- Assigns event sequence numbers
- Writes events to the log file
- Publishes to PG NOTIFY (the part we'd replace)

The SSE server would just add direct browser subscribers alongside (or instead of) PG NOTIFY.

### 3.4 Next.js SSE route current implementation

`src/app/api/sessions/[id]/events/route.ts`:

1. Validates session exists
2. Sends initial `session:state` event
3. Reads catchup events from log file
4. Subscribes to PG NOTIFY for live events
5. Pushes to SSE stream

Steps 1-3 (catchup) would move to the Worker's SSE server. Step 4 becomes direct — no PG NOTIFY needed for the live path.

### 3.5 Next.js config has no existing rewrites

`next.config.ts` currently has only `headers()` for `sw.js`. Adding `rewrites()` is clean — no conflicts.

---

## 4. Options Analysis

### Option 1: Direct SSE from Worker (separate port, CORS)

```
Browser → EventSource http://host:4102/sessions/:id/events
Browser → POST http://host:4100/api/sessions/:id/messages (unchanged)
```

**Pros**: Simplest server-side implementation, zero Next.js involvement
**Cons**: CORS complexity, browser must know two ports, firewall/proxy config needed, breaks if behind single-port reverse proxy

### Option 2: WebSocket from Worker (like terminal server)

```
Browser → WebSocket ws://host:4102/sessions/:id
```

**Pros**: Bidirectional, could merge SSE + control into one connection
**Cons**: Overkill for mostly-unidirectional events, loses `Last-Event-ID` auto-reconnect, WebSocket can't be proxied via Next.js rewrites, more complex client code

### Option 3: SSE from Worker, proxied via Next.js rewrites (RECOMMENDED)

```
Browser → EventSource /api/sessions/:id/live (port 4100)
         → Next.js rewrite → http://localhost:4102/sessions/:id/events
Worker serves SSE directly on port 4102
```

**Pros**:

- Single external port (4100) — no CORS, no firewall changes
- Worker serves SSE directly — no PG NOTIFY for live events
- No 7500 byte payload limit
- Next.js rewrite is a dumb pipe — no SSE buffering issues (response streams through)
- Catchup from log file happens in Worker (has direct access)
- Browser reconnection works via `Last-Event-ID`
- Follows terminal server pattern (separate process, own port, proxied)
- Incremental migration — keep PG NOTIFY path as fallback during transition

**Cons**:

- One more port to manage (4102, but Worker already runs as a PM2 process)
- Next.js rewrite adds one hop (but it's localhost, negligible latency)
- Must handle Worker being down (Next.js rewrite returns 502 → frontend falls back to current PG NOTIFY path?)

### Option 4: Merge Worker HTTP into Next.js custom server

**Not recommended** — loses process isolation, complicates deployments, makes restarts dangerous.

---

## 5. Recommendation: Option 3

### Why Option 3 wins

1. **Eliminates the bottleneck**: No more PG NOTIFY for real-time events. Events go directly from Worker → Browser with minimal hops.
2. **No payload limits**: PG NOTIFY's 7500 byte limit disappears. Full events always delivered.
3. **Proven pattern**: Terminal server (port 4101) already works this way. Same architecture, different protocol (SSE vs WebSocket).
4. **Single port for browser**: Next.js rewrites keep everything on port 4100. No CORS, no client changes needed.
5. **Incremental**: Can keep PG NOTIFY as fallback. Frontend can try `/api/sessions/:id/live` first, fall back to `/api/sessions/:id/events` if Worker SSE is down.
6. **Simpler Worker code**: Instead of `publish(channel, event)`, the Worker calls `sseServer.broadcast(sessionId, event)` — a direct in-memory fan-out.

### Implementation sketch

**Worker side** (`src/worker/sse-server.ts`):

```typescript
import { createServer } from 'node:http';

const SSE_PORT = parseInt(process.env.WORKER_SSE_PORT ?? '4102', 10);
const sessionSubscribers = new Map<string, Set<http.ServerResponse>>();

const server = createServer((req, res) => {
  // Parse /sessions/:id/events
  // Auth via JWT query param or header
  // Set SSE headers
  // Send catchup events from log file
  // Add res to sessionSubscribers
  // On close, remove from set
});

export function broadcast(sessionId: string, event: AgendoEvent) {
  const subs = sessionSubscribers.get(sessionId);
  if (!subs) return;
  const data = `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) {
    res.write(data);
  }
}
```

**Next.js side** (`next.config.ts`):

```typescript
async rewrites() {
  return [
    {
      source: '/api/sessions/:id/live',
      destination: 'http://localhost:4102/sessions/:id/events',
    },
  ];
}
```

**Frontend side**: Change `EventSource` URL from `/api/sessions/:id/events` to `/api/sessions/:id/live`. Keep old endpoint as fallback.

### What about PG NOTIFY?

PG NOTIFY is still needed for:

- **Control messages** (browser → Worker): POST → PG NOTIFY → Worker. This is low-volume and works fine.
- **Brainstorm events**: Different subsystem, keep as-is.
- **Out-of-band status changes**: Stale reaper, zombie reconciler, cancel API — these update DB + broadcast via PG NOTIFY. With direct SSE, they'd call the Worker's broadcast function instead (or the Worker polls/subscribes for these).

PG NOTIFY for session events becomes optional/fallback, not the primary path.

### PM2 config change

```js
// ecosystem.config.js — add WORKER_SSE_PORT
{
  name: 'agendo-worker',
  env: {
    WORKER_SSE_PORT: '4102',
    // ... existing env
  },
}
```

No new PM2 process needed — the HTTP server runs inside the existing Worker process.

---

## 6. Risk Assessment

| Risk                                  | Mitigation                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Worker down → no SSE                  | Frontend detects 502, falls back to PG NOTIFY SSE endpoint                                  |
| Worker restart → SSE connections drop | `EventSource` auto-reconnects with `Last-Event-ID`; Worker replays from log file            |
| Multiple Workers (future)             | Only the Worker owning the session serves its SSE. Rewrite could include Worker ID routing. |
| Memory pressure from SSE connections  | Each SSE connection is ~1KB overhead. Even 100 concurrent viewers is negligible.            |
| Auth                                  | JWT in query param (same as terminal server) or forwarded from Next.js rewrite headers      |

---

## 7. Migration Path

1. **Phase 1**: Add SSE server to Worker. Keep PG NOTIFY publishing too (dual-write).
2. **Phase 2**: Add Next.js rewrite. Frontend uses `/api/sessions/:id/live` with fallback.
3. **Phase 3**: Once stable, remove PG NOTIFY publishing for session events (keep for control + brainstorm).
4. **Phase 4**: Remove old `/api/sessions/:id/events` SSE route in Next.js.

Each phase is independently deployable and reversible.
