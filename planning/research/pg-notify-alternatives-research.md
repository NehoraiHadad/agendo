# IPC Alternatives to pg_notify: Research Report

> Date: 2026-03-16
> Context: Agendo has two Node.js processes (Worker + Next.js) on the same server communicating via PostgreSQL LISTEN/NOTIFY. This document evaluates alternatives.

## Table of Contents

1. [Current State: pg_notify Costs](#1-current-state-pg_notify-costs)
2. [Unix Domain Sockets](#2-unix-domain-sockets)
3. [File-Based Event Streaming (inotify/fs.watch)](#3-file-based-event-streaming)
4. [Worker HTTP Endpoint](#4-worker-http-endpoint)
5. [WebSocket Between Processes](#5-websocket-between-processes)
6. [Node.js child_process IPC](#6-nodejs-child_process-ipc)
7. [Named Pipes (FIFOs)](#7-named-pipes-fifos)
8. [Shared Memory](#8-shared-memory)
9. [pg-boss Built-in Pub/Sub](#9-pg-boss-built-in-pubsub)
10. [Redis Pub/Sub](#10-redis-pubsub)
11. [The Brandur Notifier Pattern (Optimize pg_notify)](#11-the-brandur-notifier-pattern)
12. [Real-World Examples](#12-real-world-examples)
13. [Comparison Matrix](#13-comparison-matrix)
14. [Top 3 Recommendations](#14-top-3-recommendations)

---

## 1. Current State: pg_notify Costs

Agendo's current pg_notify usage (`src/lib/realtime/pg-notify.ts`):

- **Publish path**: Each event → `SELECT pg_notify(channel, payload)` via Drizzle pool (1 query per event)
- **Subscribe path**: Multiplexed — one PG connection per distinct channel, fan out to N listeners
- **Listener pool**: Dedicated `Pool({ max: 20 })` separate from Drizzle pool
- **Payload limit**: 8KB hard limit, worked around with `{type:'ref'}` stub for large payloads
- **Channels**: `agendo_events_{sessionId}`, `agendo_control_{sessionId}`, `brainstorm_events_*`, `brainstorm_control_*`
- **Heartbeat**: 60s keepalive per channel slot
- **Reconnect**: Exponential backoff with listener preservation

**Measured costs**:

- 2 DB round-trips per event on the hot path (publish from worker + internal Drizzle query)
- 20 dedicated PG connections for the listener pool
- PG global advisory lock on NOTIFY (serialization point)
- 2-5ms latency per notification (PG NOTIFY measured latency)
- Fire-and-forget semantics (no delivery guarantee, but log files provide replay)

---

## 2. Unix Domain Sockets

### How They Work

Unix domain sockets (UDS) use the filesystem namespace (`/tmp/agendo-ipc.sock`) for bidirectional communication between processes on the same machine. They bypass the entire TCP/IP network stack.

### Performance Benchmarks

| Metric                       | TCP Loopback | Unix Domain Socket | Improvement    |
| ---------------------------- | ------------ | ------------------ | -------------- |
| Latency                      | 334 µs       | 130 µs             | **61% lower**  |
| Small msg throughput (10B)   | 168K req/s   | 192K req/s         | **15% higher** |
| Large msg throughput (100KB) | 16.5K req/s  | 24.5K req/s        | **48% higher** |
| Large msg throughput (1MB)   | 1.6K req/s   | 2.5K req/s         | **56% higher** |

Sources: [NodeVibe UDS benchmark](https://nodevibe.substack.com/p/the-nodejs-developers-guide-to-unix), [TCP/UDS/Named Pipe benchmark](https://www.yanxurui.cc/posts/server/2023-11-28-benchmark-tcp-uds-namedpipe/)

### Node.js Implementation

Node.js `net` module natively supports UDS:

```typescript
// Server (Worker)
const server = net.createServer((socket) => {
  socket.on('data', handleControl);
  // push events to connected clients
});
server.listen('/tmp/agendo-ipc.sock');

// Client (Next.js)
const client = net.connect('/tmp/agendo-ipc.sock');
client.write(JSON.stringify(event));
```

Libraries like `node-json-socket` add JSON framing (length-prefixed messages) on top of raw sockets.

### Pros

- **Fastest option**: 130µs latency vs 2-5ms for pg_notify (~15-40x faster)
- **No payload limit**: Arbitrary message sizes (no 8KB restriction)
- **No DB load**: Zero PG connections needed for IPC
- **Native Node.js support**: `net.createServer`/`net.connect` with path
- **File permission security**: Unix file permissions control access
- **Bidirectional**: Single socket handles both events and control signals
- **No external dependencies**: Built into Node.js and the OS

### Cons

- **Same-machine only**: Cannot work across servers (fine for Agendo's single-server setup)
- **Connection management**: Must handle reconnects, socket cleanup on crash
- **Message framing required**: Raw sockets are streams, not messages — need length-prefix or newline-delimited JSON (NDJSON)
- **No fan-out built in**: Must implement pub/sub multiplexing (or use one socket per session)
- **Socket file cleanup**: Stale `.sock` files from crashes need cleanup on startup

### Verdict: STRONG CANDIDATE

Best raw performance. Requires building a thin message framing layer but the complexity is manageable. Agendo already deals with NDJSON in its Codex adapter.

---

## 3. File-Based Event Streaming

### The Concept

The Worker already writes every event to a log file. The SSE endpoint already reads from this file on reconnect. The idea: use `fs.watch()` / inotify as the notification mechanism instead of pg_notify.

**Pattern**: Writer appends to file → inotify fires → Reader tails new lines → pushes to SSE

### inotify on Linux

inotify is a Linux kernel subsystem for filesystem event notification. Key characteristics:

- **Mechanism**: Kernel-level, event-driven (not polling)
- **Latency**: Sub-millisecond — events fire as soon as the VFS operation completes. No published formal benchmarks, but kernel-level notification is effectively instant (limited only by syscall overhead, ~1-10µs)
- **Reliability**: Can suffer queue overflow under extreme write rates (default queue: 16384 events), but "the odds of observing a queue overflow on a default configured mainstream GNU/Linux distribution is very low" ([fswatch manpage](https://manpages.debian.org/testing/fswatch/fswatch.7.en.html))
- **Scalability**: Scales well with number of watched items; watching a parent directory and filtering is often better than many individual watches

Source: [inotify(7) man page](https://man7.org/linux/man-pages/man7/inotify.7.html), [Linux Kernel inotify docs](https://docs.kernel.org/filesystems/inotify.html)

### Node.js fs.watch Reliability

**Known issues** ([Node.js issue #47058](https://github.com/nodejs/node/issues/47058)):

- `fs.watch` behavior "varies wildly across operating systems"
- Watching a parent folder is "hyper slow" compared to watching the file directly — can miss 97% of events
- On Linux (inotify), watching individual files is reliable; directory watching less so

**Chokidar** (30M+ repos use it):

- Wraps `fs.watch` with stat-checking to normalize events
- v5 (Nov 2025) is ESM-only, requires Node 20+
- Production-proven in Webpack, Vite, and most build tools
- Adds overhead from stat checks but provides reliable cross-platform behavior

**However**: For our use case (tailing a single, append-only log file), raw `fs.watch` on Linux is reliable. We're watching one specific file per session, not a directory tree.

### The Brandur Notifier Pattern

[Brandur Leach's "Notifier Pattern"](https://brandur.org/notifier) ([HN discussion](https://news.ycombinator.com/item?id=40352686)):

- **Problem**: Naive LISTEN/NOTIFY uses one PG connection per topic per process, exhausting connections
- **Solution**: Single PG connection per process, multiplexing all topics through it
- **Key insight**: "A single connection can listen on any number of topics"
- **Non-blocking sends**: Uses buffered channels; if a consumer falls behind, notifications are discarded (not queued)
- **Let it crash**: No complex reconnection — terminate process on irrecoverable connection failure

**Relevance to Agendo**: We already implement a version of this (the channel multiplexer in `pg-notify.ts`). The Notifier Pattern validates our current approach but doesn't eliminate the PG dependency.

**Hybrid idea**: Use the Notifier Pattern concept but with _files_ instead of PG — the log file IS the durable event stream, and a lightweight notification (inotify or UDS ping) replaces pg_notify for the "wake up" signal.

### Pros

- **Already half-built**: Worker writes log files; SSE reads them on reconnect
- **Zero additional infrastructure**: Files + inotify are OS primitives
- **Natural persistence**: Log file IS the event store (unlike pg_notify which is fire-and-forget)
- **No payload limit**: File entries can be any size
- **Eliminates PG connection pool**: No listener pool needed
- **Simplifies reconnect**: SSE reconnect = seek to last byte offset in file

### Cons

- **fs.watch edge cases**: Needs careful handling (watch the file, not directory; handle file rotation)
- **Latency uncertainty**: While inotify is fast (~µs), Node.js fs.watch adds event loop latency. No published Node.js-specific benchmarks for this pattern
- **Control channel needs separate solution**: File watching only solves events (Worker→Frontend). Control signals (Frontend→Worker) still need a channel — could use a separate control file or UDS
- **No built-in fan-out**: Multiple SSE clients watching same session need separate file watchers (or a shared watcher with fan-out)
- **File descriptor limits**: Each watcher uses an fd; many concurrent sessions = many watchers

### Verdict: STRONG CANDIDATE (for event streaming)

Excellent fit for the Worker→Frontend event path since the log file already exists. Must be combined with another mechanism (UDS or HTTP) for the control path (Frontend→Worker).

---

## 4. Worker HTTP Endpoint

### The Concept

Worker exposes a lightweight HTTP server (or HTTP-over-UDS) that the Next.js process calls to send control signals and optionally subscribe to events.

### Implementation Options

| Option                     | Overhead | Latency |
| -------------------------- | -------- | ------- |
| `http.createServer` (bare) | ~2MB RAM | ~0.5ms  |
| Fastify on TCP             | ~3MB RAM | ~0.3ms  |
| Fastify on UDS             | ~3MB RAM | ~0.15ms |
| Express on TCP             | ~5MB RAM | ~0.8ms  |

[Fastify](https://fastify.dev/docs/latest/Reference/Server/) natively supports Unix domain socket listeners.

### Architecture

```
Next.js (port 4100)                    Worker
  │                                      │
  ├── POST /control/:sessionId ──────►  HTTP server (UDS or port 4102)
  │   (messages, approvals, cancel)      ├── routes session control
  │                                      │
  ◄── SSE /events/:sessionId ────────   ├── (optional) SSE push
      (or use file-tailing instead)      │
```

### Pros

- **Simple, familiar**: HTTP is well-understood; easy to debug with curl
- **Request/response semantics**: Can confirm delivery (unlike pg_notify fire-and-forget)
- **Auth possible**: JWT or shared secret on localhost
- **Fastify on UDS**: Best of both worlds — HTTP semantics with UDS performance
- **Works for control path**: Perfect for Frontend→Worker signals

### Cons

- **Extra process/port**: Need to manage another listener (or UDS socket file)
- **Overkill for streaming**: HTTP request/response is not ideal for continuous event streaming (SSE from Worker would work but adds complexity)
- **Two-way requires either SSE or polling from Worker side**: Worker can't initiate requests to Next.js easily (Next.js doesn't expose a control endpoint currently)

### Verdict: GOOD for control path

HTTP on UDS is an excellent replacement for pg_notify's control channel. Not ideal as the sole mechanism for high-frequency event streaming.

---

## 5. WebSocket Between Processes

### The Concept

Use the `ws` library to create a WebSocket connection between Worker and Next.js for bidirectional streaming.

### Performance

- WebSocket adds framing overhead on top of TCP (~2-14 bytes per message)
- `ws` library for Node.js is well-maintained, production-grade
- With `permessage-deflate` disabled: minimal overhead vs raw TCP
- Latency: ~0.5-1ms on localhost (TCP), ~0.2-0.5ms on UDS

### Pros

- **True bidirectional**: Both sides can push messages at any time
- **Message framing built in**: No need for length-prefix or NDJSON parsing
- **Reconnect patterns well-established**: Libraries handle this
- **Fan-out natural**: Multiple clients can connect to same WS server

### Cons

- **Overkill for 2 processes**: WebSocket protocol overhead (HTTP upgrade handshake, frame headers) is unnecessary for local IPC
- **Extra dependency**: `ws` library (though Agendo already uses it for terminal server)
- **Complexity**: More moving parts than plain UDS or HTTP
- **Port/socket management**: Same as HTTP — need a listener

### Verdict: ACCEPTABLE but over-engineered

WebSocket works but adds unnecessary protocol overhead for two co-located processes. A plain UDS or HTTP-on-UDS is simpler and faster.

---

## 6. Node.js child_process IPC

### How It Works

If one process spawns the other via `child_process.fork()`, they get a built-in IPC channel using `process.send()` / `process.on('message')`.

### Performance

- **Latency**: ~90-100ms round-trip for small messages ([Node.js issue #3145](https://github.com/nodejs/node/issues/3145))
- **Large payloads**: 40MB JSON → 250-300 seconds (extremely slow due to JSON serialization)
- **CPU**: Master process consumes up to 90% of a core under heavy IPC load
- **Mechanism**: Uses a Unix domain socket under the hood, but adds JSON serialization overhead

### Applicability to Agendo

- **Not applicable**: Worker and Next.js are independent PM2-managed processes, not parent-child
- PM2 manages them as separate process trees
- Would require architectural change to make one process spawn the other

### Pros

- Zero setup if parent-child relationship exists
- Built into Node.js

### Cons

- **Not applicable**: Processes are independent (PM2-managed)
- **Terrible performance**: 100ms latency, CPU-intensive serialization
- **Scaling issues**: Single master bottleneck at 90% CPU

### Verdict: NOT APPLICABLE

Agendo's processes are independent PM2 services. Even if applicable, the performance is poor.

---

## 7. Named Pipes (FIFOs)

### How They Work

Named pipes are filesystem-based, unidirectional IPC channels created with `mkfifo`.

### Performance

- Comparable to Unix domain sockets for small messages (~2ms at 10B)
- **Degrades significantly for large payloads**: 1MB → 497ms vs 162ms for UDS (3x slower)
- Source: [TCP/UDS/Named Pipe benchmark](https://www.yanxurui.cc/posts/server/2023-11-28-benchmark-tcp-uds-namedpipe/)

### Pros

- Simple, OS-level primitive
- No library needed

### Cons

- **Unidirectional**: Need two pipes for bidirectional communication
- **Blocking I/O**: Can block if reader isn't consuming
- **No multiplexing**: One pipe per channel
- **Worse than UDS for large messages**: 3x slower at 1MB payloads
- **Less ergonomic in Node.js**: No built-in `net` module support (must use `fs.open`/`fs.read`)

### Verdict: INFERIOR TO UDS

Unix domain sockets are strictly better — bidirectional, faster for large messages, and have native Node.js support.

---

## 8. Shared Memory

### How It Works

- **SharedArrayBuffer**: Available in `worker_threads` (same process), not between separate processes
- **POSIX shared memory**: Available via native addons (`shm-typed-array`, `posix-shm`)
- **mmap**: Memory-mapped files shared between processes

### Applicability

- `SharedArrayBuffer` is for threads, not processes — **not applicable**
- POSIX shared memory requires native addons and manual synchronization (mutexes/semaphores)
- No established Node.js libraries for production cross-process shared memory

### Pros

- Theoretically lowest latency (zero-copy)
- High throughput for large data

### Cons

- **No production-ready Node.js libraries** for cross-process shared memory
- Requires native addons (compilation, platform issues)
- Must implement synchronization primitives manually
- Not event-driven — needs a separate notification mechanism
- Extreme complexity for marginal latency gains over UDS

### Verdict: NOT RECOMMENDED

Too complex, too fragile, no ecosystem support. UDS at 130µs is more than fast enough.

---

## 9. pg-boss Built-in Pub/Sub

### How It Works

pg-boss uses **polling**, not PostgreSQL LISTEN/NOTIFY:

- Workers poll the `pgboss.job` table at a configurable interval
- v10 config: `pollingIntervalSeconds` (replaces v9's `newJobCheckInterval`)
- Job detection uses `SKIP LOCKED` for safe concurrent access
- `onComplete()` creates completion jobs for subscribers to poll

Source: [pg-boss issue #93](https://github.com/timgit/pg-boss/issues/93) — "the implementation does not use postgres' pub/sub mechanisms... it is just a polling worker distribution"

### Latency

- **Minimum latency = polling interval** (default: 2 seconds in v10)
- Can be reduced to 0.5s but increases DB load
- Not suitable for real-time event streaming (<100ms latency needed)

### Pros

- Already in the stack (Agendo uses pg-boss for job queues)
- No additional infrastructure

### Cons

- **Polling, not push**: Minimum latency is the polling interval
- **Not designed for real-time streaming**: It's a job queue, not a pub/sub system
- **DB load scales with polling frequency**: Reducing interval increases query load
- **Wrong abstraction**: Events are not jobs

### Verdict: NOT SUITABLE

pg-boss is a job queue, not a real-time event bus. Polling latency is too high for streaming AI agent output.

---

## 10. Redis Pub/Sub

### How It Works

Redis provides built-in publish/subscribe with push-based delivery.

### Performance

- **Latency**: 1-2ms (vs 2-5ms for pg_notify)
- **Throughput**: Handles millions of messages per second
- **No payload limit**: (practically — Redis strings up to 512MB)

### Pros

- Well-established pub/sub with push delivery
- Rich ecosystem (ioredis, Bull/BullMQ)
- Fan-out built in
- Pattern subscriptions

### Cons

- **Adds infrastructure**: New dependency (Redis server), new failure mode
- **Memory usage**: Redis is in-memory; adds to the 16GB server's memory pressure
- **Overkill**: For 2 processes on the same machine, Redis adds unnecessary network hops
- **Not needed**: UDS achieves lower latency without any external dependency

### Verdict: NOT RECOMMENDED

Adding Redis for IPC between 2 co-located processes is over-engineering. UDS is faster and has zero infrastructure requirements.

---

## 11. The Brandur Notifier Pattern

### Summary

[Brandur Leach's Notifier Pattern](https://brandur.org/notifier) optimizes pg_notify usage:

- **One PG connection per process** for all LISTEN channels (instead of one per channel)
- Non-blocking fan-out to in-process subscribers
- Let-it-crash on irrecoverable connection failure
- Works with PgBouncer session pooling

### Agendo Already Implements This

The channel multiplexer in `src/lib/realtime/pg-notify.ts` is essentially the Notifier Pattern:

- One PG connection per channel (could be further optimized to one total)
- Fan-out to N listeners per channel
- Reconnect with exponential backoff

### Potential Optimization

Could reduce from one-connection-per-channel to one-connection-total by having a single PG connection that LISTENs on all active channels. This would reduce the listener pool from max=20 to max=1.

### Verdict: USEFUL OPTIMIZATION (if keeping pg_notify)

If pg_notify is retained, implementing the full Notifier Pattern (single connection) would reduce the connection pool from 20 to 1. However, this doesn't address the fundamental costs (DB queries on publish, 8KB limit, PG lock contention).

---

## 12. Real-World Examples

### How Production Systems Handle Worker↔API IPC

| System               | IPC Mechanism       | Notes                                                                    |
| -------------------- | ------------------- | ------------------------------------------------------------------------ |
| **Temporal**         | gRPC (network)      | Workers poll Temporal Server via gRPC. Designed for distributed systems. |
| **Inngest**          | HTTP webhooks       | API sends HTTP to workers. Cloud-native, not same-machine.               |
| **BullMQ**           | Redis               | Workers poll Redis queues. Real-time events via Redis pub/sub.           |
| **PM2**              | Unix domain sockets | Process manager uses UDS for inter-process communication.                |
| **PostgreSQL**       | Unix domain sockets | DB clients connect via UDS for 30% lower latency than TCP.               |
| **Nginx → upstream** | Unix domain sockets | Reverse proxy to app servers via UDS in production.                      |
| **Docker**           | Unix domain socket  | Docker daemon communicates via `/var/run/docker.sock`.                   |
| **systemd**          | Unix domain socket  | Socket activation and service communication.                             |

**Key observation**: For same-machine IPC, Unix domain sockets are the overwhelming industry standard. TCP/HTTP is used when processes may be on different machines. PostgreSQL LISTEN/NOTIFY is used when you already need the DB and want to avoid adding infrastructure.

Sources: [Temporal docs](https://docs.temporal.io/workers), [BullMQ docs](https://bullmq.io/), [PostgreSQL UDS benchmark](https://zaiste.net/posts/postgresql-unix-socket-tcpip-loopback/)

---

## 13. Comparison Matrix

| Criterion                 | pg_notify (current) | Unix Domain Socket | File + inotify                | HTTP on UDS    | WebSocket  | Redis        |
| ------------------------- | ------------------- | ------------------ | ----------------------------- | -------------- | ---------- | ------------ |
| **Latency**               | 2-5ms               | ~130µs             | ~1-10µs (kernel) + event loop | ~150µs         | ~200-500µs | 1-2ms        |
| **PG connections**        | 20 pool             | 0                  | 0                             | 0              | 0          | 0            |
| **DB queries/event**      | 1 (publish)         | 0                  | 0                             | 0              | 0          | 0            |
| **Payload limit**         | 8KB                 | None               | None                          | None           | None       | None         |
| **Bidirectional**         | Yes (2 channels)    | Yes (1 socket)     | No (write-only)               | Yes (req/res)  | Yes        | Yes          |
| **Persistence**           | No                  | No                 | Yes (log file)                | No             | No         | No           |
| **Fan-out**               | PG handles          | Must implement     | Must implement                | Must implement | Built in   | Built in     |
| **Infrastructure**        | PG (existing)       | OS (free)          | OS (free)                     | OS (free)      | ws library | Redis server |
| **Reconnect complexity**  | Medium              | Medium             | Low                           | Low            | Medium     | Medium       |
| **Implementation effort** | Already done        | Medium (~200 LoC)  | Low (~100 LoC)                | Low (~100 LoC) | Medium     | High         |

---

## 14. Top 3 Recommendations

### Recommendation 1: Hybrid — File Tailing (events) + UDS/HTTP (control)

**Architecture**:

```
Worker writes events → log file (already exists)
                    → inotify/fs.watch fires
                    → SSE endpoint tails file, pushes to browser

Next.js sends control → HTTP POST to Worker (UDS socket)
                     → Worker routes to correct session
```

**Why this is the best option**:

- Events path is **already 80% built** (log file writing + SSE replay from file)
- Eliminates ALL PG connections for IPC (saves 20 connections)
- Eliminates ALL DB queries on the hot event path
- No payload limit (no more ref/stub workaround)
- Log file provides natural persistence and replay
- Control path gets request/response semantics (delivery confirmation)
- ~300 LoC total implementation

**Risks**: fs.watch edge cases on Linux (mitigated by watching individual files, not directories)

### Recommendation 2: Pure Unix Domain Socket

**Architecture**:

```
Worker ←→ UDS server (/tmp/agendo-ipc.sock) ←→ Next.js
  - NDJSON protocol (one JSON message per line)
  - Bidirectional: events flow Worker→Next.js, control flows Next.js→Worker
  - Session routing via message envelope: {sessionId, type, payload}
```

**Why this is strong**:

- 130µs latency (15-40x faster than pg_notify)
- Single bidirectional channel replaces both event and control pg_notify channels
- No payload limit, no DB load
- Industry standard for same-machine IPC (PM2, Docker, systemd all use it)
- ~200 LoC for NDJSON-over-UDS server/client

**Risks**: Must implement message routing/fan-out; socket file cleanup on crash

### Recommendation 3: Optimize Current pg_notify (Notifier Pattern)

**Architecture**:

```
Same as current, but:
- Single PG connection for ALL channels (not one per channel)
- Reduce listener pool from max=20 to max=1
- Keep everything else the same
```

**Why this is pragmatic**:

- Smallest change (~50 LoC refactor of pg-notify.ts)
- Reduces PG connections from 20 to 1
- Keeps the proven, working architecture
- Can be combined with Recommendation 1 later as a migration path

**Limitations**: Still has DB query on publish, 8KB limit, PG lock contention. Optimization, not elimination.

---

## Appendix: Source Links

- [60devs IPC Performance in Node.js](https://60devs.com/performance-of-inter-process-communications-in-nodejs.html)
- [NodeVibe: Unix Domain Sockets Guide](https://nodevibe.substack.com/p/the-nodejs-developers-guide-to-unix)
- [TCP/UDS/Named Pipe Benchmark](https://www.yanxurui.cc/posts/server/2023-11-28-benchmark-tcp-uds-namedpipe/)
- [Brandur Leach: The Notifier Pattern](https://brandur.org/notifier) | [HN Discussion](https://news.ycombinator.com/item?id=40352686)
- [Chokidar GitHub](https://github.com/paulmillr/chokidar)
- [Node.js fs.watch issues #47058](https://github.com/nodejs/node/issues/47058)
- [pg-boss: Not using PG pub/sub (issue #93)](https://github.com/timgit/pg-boss/issues/93)
- [pg-boss v10 release notes](https://github.com/timgit/pg-boss/releases/tag/10.0.0)
- [Node.js child_process IPC slowness (issue #3145)](https://github.com/nodejs/node/issues/3145)
- [Fastify Server docs (UDS support)](https://fastify.dev/docs/latest/Reference/Server/)
- [node-json-socket](https://github.com/sebastianseilund/node-json-socket)
- [inotify(7) man page](https://man7.org/linux/man-pages/man7/inotify.7.html)
- [PostgreSQL UDS vs TCP benchmark](https://zaiste.net/posts/postgresql-unix-socket-tcpip-loopback/)
- [Unix Domain Sockets for Microservices](https://medium.com/@sanathshetty444/beyond-http-unleashing-the-power-of-unix-domain-sockets-for-high-performance-microservices-252eee7b96ad)
- [pg_notify latency: PG vs Redis](https://dev.to/polliog/i-replaced-redis-with-postgresql-and-its-faster-4942)
- [Temporal Worker docs](https://docs.temporal.io/workers)
- [BullMQ docs](https://bullmq.io/)
