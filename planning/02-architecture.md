# agendo - Architecture

> Last updated: 2026-02-17
> Stack: Next.js 16 (React 19.2) + Drizzle ORM + Postgres + pg-boss
> Schema: 03-data-model.md | Phases: 04-phases.md | Research: research-\*.md

---

## 1. System Overview

```
┌───────────────────────────────────────────────────────────────┐
│                        Browser (UI)                            │
│  Next.js App: Dashboard, Kanban Board, Agent Registry,        │
│  Execution Logs, SSE Log Viewer, xterm.js Web Terminal        │
└─────────┬─────────────────────────────────┬───────────────────┘
          │ HTTP + SSE                      │ WebSocket (on-demand)
┌─────────▼─────────────────────┐  ┌───────▼───────────────────┐
│  Next.js API + Server Actions │  │  WebSocket Terminal Server │
│  CRUD, SSE log streaming,     │  │  node-pty + tmux attach    │
│  board updates                │  │  JWT auth per connection   │
│  Port 4100                    │  │  Port 4101                 │
└─────────┬─────────────────────┘  └───────────────────────────┘
          │ Drizzle ORM (node-postgres pool)        │
┌─────────▼─────────────────────────────────────────┐
│           Direct Postgres (single container)       │
│  See 03-data-model.md for full schema             │
└─────────┬─────────────────────────────────────────┘
          │ pg-boss (FOR UPDATE SKIP LOCKED)
┌─────────▼─────────────────────────────────────────┐
│       Worker (separate OS process)                 │
│  Claims queued executions, manages adapters        │
│  Writes structured output, updates heartbeat       │
└─────────┬─────────────────────────────────────────┘
          │ Per-agent adapters (all run inside tmux sessions)
┌─────────▼─────────────────────────────────────────┐
│            tmux (process isolation layer)           │
│  ┌──────────────┐ ┌────────────┐ ┌──────────────┐ │
│  │ Claude Code   │ │ Codex CLI  │ │ Gemini CLI   │ │
│  │ stream-json   │ │ app-server │ │ send-keys /  │ │
│  │ bidirectional │ │ JSON-RPC   │ │ capture-pane │ │
│  └──────────────┘ └────────────┘ └──────────────┘ │
│  ┌──────────────────────────────────────────────┐  │
│  │ Template Mode: git, docker, npm, custom CLI  │  │
│  └──────────────────────────────────────────────┘  │
└────────────────────────┬──────────────────────────┘
                         │ MCP Protocol (stdio / HTTP)
┌────────────────────────▼──────────────────────────┐
│          agendo MCP Server                         │
│  Tools: create_task, update_task, list_tasks,      │
│  create_subtask, assign_task, spawn_agent          │
│  Agents connect via --mcp-config / .mcp.json       │
└───────────────────────────────────────────────────┘
```

### Key Decisions

| #   | Decision                                                                      | Rationale                                                                                                                                               |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No Supabase** -- Direct Postgres + Drizzle ORM                              | Supabase local needs ~8 Docker containers, 1GB+ RAM. Single Postgres + Drizzle is lighter. SSE replaces Supabase Realtime.                              |
| 2   | **No monorepo** -- Single `package.json`, folder separation                   | Worker imports shared code from `src/lib/` directly. No workspace tooling needed.                                                                       |
| 3   | **Three OS processes** -- Next.js + worker + terminal server                  | No shared in-process state. Communication via database + filesystem. WebSocket terminal server isolated for crash safety.                               |
| 4   | **SSE via fs.watch** -- Log streaming tails files with inotify                | Worker and Next.js are separate processes. EventEmitter is invisible across process boundaries. 500ms polling fallback.                                 |
| 5   | **CLI-only, no SDKs or API keys** -- All AI agents run as CLI subprocesses    | Uses user's existing OAuth/login (Claude Pro/Max, Google account, OpenAI login). Zero additional API costs. Uniform adapter pattern across all agents.  |
| 6   | **tmux as process layer** -- All AI agents run inside tmux sessions           | Enables attach/detach (user closes browser, agent continues), multiple viewers, session persistence across restarts. Required for web terminal feature. |
| 7   | **MCP Server for agent communication** -- Agents call back into Agent Monitor | Bidirectional: Agent Monitor spawns agents AND agents report status/create tasks via MCP tools. Closes the feedback loop.                               |

---

## 2. Processes

Three independent OS processes. The process manager is a **deployment detail** — any of PM2, Docker Compose, systemd, or bare `node` works.

| Process                  | Role                                               | Port | Recommended Memory |
| ------------------------ | -------------------------------------------------- | ---- | ------------------ |
| `agent-monitor`          | Next.js web server                                 | 4100 | 1G                 |
| `agent-monitor-worker`   | Job executor (spawns agents in tmux)               | —    | 512M               |
| `agent-monitor-terminal` | WebSocket terminal server (node-pty + tmux attach) | 4101 | 256M               |

**Why a separate terminal server?** The WebSocket terminal server handles long-lived connections with node-pty (native addon). Crash isolation: if node-pty segfaults or a PTY leaks, only the terminal server restarts — the Next.js app and worker continue unaffected. This also avoids patching Next.js for WebSocket support.

### Deployment: PM2 (instance-neo)

PM2 config added to `/home/ubuntu/projects/ecosystem.config.js`. `agent-monitor`: `script: PNPM, args: 'start'`, port 4100, `max_restarts: 5`. `agent-monitor-worker`: `script: 'node', args: 'dist/worker/index.js'`, `max_restarts: 10`. `agent-monitor-terminal`: `script: 'node', args: 'dist/terminal/server.js'`, port 4101, `max_restarts: 10`.

Memory budget on instance-neo: existing apps ~3-4G + agent-monitor 1G + worker 512M + terminal 256M = well within 12GB limit.

### Deployment: Docker Compose (alternative)

```yaml
services:
  web:
    build: .
    command: pnpm start
    ports: ['4100:4100']
    depends_on: [postgres]
  worker:
    build: .
    command: node dist/worker/index.js
    depends_on: [postgres]
  terminal:
    build: .
    command: node dist/terminal/server.js
    ports: ['4101:4101']
  postgres:
    image: postgres:16
    volumes: [pgdata:/var/lib/postgresql/data]
```

---

## 3. Dual Execution Mode

Two execution strategies determined by `agent_capabilities.interaction_mode`.

### Template Mode (CLI tools)

- Capability defines `command_tokens`: `["git", "checkout", "{{branch}}"]`
- Worker substitutes args into tokens, spawns with `shell: false`
- `stdio: ['ignore', 'pipe', 'pipe']` -- stdin ignored
- Short-lived (seconds to minutes)

### Prompt Mode (AI agents)

- Capability defines `prompt_template` with placeholders: `{{task_title}}\n\n{{task_description}}`
- Worker interpolates template and delegates to the appropriate **per-agent adapter**
- **All AI agents run inside tmux sessions** for attach/detach support (see §19)
- **All AI tools are CLI binaries** using the user's existing OAuth/login — no API keys, no embedded SDKs
- Long-running (minutes to tens of minutes)
- `executions.session_ref` stores external session IDs for resume support (see §18)
- **Bidirectional**: Can send additional messages to Claude and Codex during execution (multi-turn)

#### Per-Agent Communication Protocols

| Agent              | Protocol       | Communication                               | How It Works                                                                                                                                                                                                       |
| ------------------ | -------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Claude Code**    | `stream-json`  | Bidirectional NDJSON over stdin/stdout      | `claude -p --input-format stream-json --output-format stream-json --verbose`. Send `{"type":"user","message":...}` on stdin, read structured events from stdout. Multi-turn: send additional messages at any time. |
| **Codex CLI**      | `app-server`   | Bidirectional JSON-RPC over stdin/stdout    | `codex app-server`. Initialize handshake, then `thread/start`, `turn/start`, `turn/steer` (mid-turn injection), `turn/interrupt`. Full request/response/notification protocol.                                     |
| **Gemini CLI**     | tmux send-keys | Pseudo-bidirectional via terminal emulation | No native bidirectional protocol. Run in interactive mode inside tmux. Send messages via `tmux send-keys`, read output via `tmux capture-pane` or `pipe-pane` to log file.                                         |
| **Template tools** | Simple spawn   | One-directional (fire-and-forget)           | `spawn(binary, args, { shell: false })`. stdin ignored. Short-lived.                                                                                                                                               |

#### Why CLI-Only, Not SDKs or APIs

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and direct APIs (Anthropic Messages API, OpenAI API, Google Gemini API) all require **API keys with per-token billing**. Agent Monitor uses the **CLI binaries with the user's existing subscription** (Claude Pro/Max, Google account, OpenAI login) so there are zero additional API costs. Additionally:

- CLI provides built-in tools (Read, Write, Bash, Glob, Grep) that SDKs lack
- CLI manages session persistence on disk automatically
- Uniform subprocess pattern across all agents (no SDK for one, subprocess for others)

### Mode Enforcement

`interaction_mode = 'template'` requires non-null `command_tokens` (check constraint in schema). `interaction_mode = 'prompt'` allows null `command_tokens`, uses `prompt_template` instead. See 03-data-model.md for constraint definition.

---

## 4. Cancellation Flow

### Status Progression

```
running -> cancelling -> cancelled
                      -> failed (if SIGKILL needed)
```

### Flow

1. User clicks Cancel
2. `POST /api/executions/:id/cancel` -- validates status is `running`, sets `cancelling`, returns 202
3. Worker sends `SIGTERM` to child PID
4. 5-second grace period, then `SIGKILL` if still running
5. Final status: `cancelled` (or `failed` if kill failed)

### Why `cancelling` Exists

Without it, the API sets `cancelled` immediately while the worker still writes output. The intermediate state signals intent without closing the record prematurely.

### Race Guard

Worker completion updates MUST use `WHERE status = 'running'`. If status changed to `cancelling` mid-execution and the update returns 0 rows, the worker checks current status and sets `cancelled` instead of `succeeded`.

---

## 5. Job Queue: pg-boss

**Why pg-boss instead of raw SQL:** Writing a job queue from scratch requires 200-400 lines of careful code (expiration, retry, dead letter, graceful shutdown). pg-boss (3,100+ stars, 96K weekly downloads) wraps `FOR UPDATE SKIP LOCKED` internally and provides all of this out of the box. Used in production since 2016. No Redis/RabbitMQ needed — runs on the same Postgres.

See `research-queue-systems.md` for full analysis of alternatives (Graphile Worker, BullMQ, raw SQL, PGMQ).

### Setup

```typescript
import PgBoss from 'pg-boss';

const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schema: 'pgboss', // separate schema, doesn't pollute public
});
await boss.start();
```

### Job Lifecycle

```typescript
// Enqueue (API route or server action)
await boss.send(
  'execute-capability',
  {
    executionId,
    capabilityId,
    agentId,
    args,
  },
  {
    expireInMinutes: 45, // safety net for hung processes
    retryLimit: 2, // retry on transient failure
    retryDelay: 30, // 30s between retries
    singletonKey: agentId, // optional: prevent duplicate per-agent
  },
);

// Worker claims and processes (pg-boss handles SKIP LOCKED internally)
await boss.work(
  'execute-capability',
  {
    teamSize: 3, // max 3 concurrent jobs per worker instance
    teamConcurrency: 1, // claim 1 at a time
  },
  async (job) => {
    const { executionId, capabilityId, args } = job.data;
    // ... spawn process, write logs, update execution ...
  },
);
```

### What pg-boss Handles (that we don't write)

| Feature                              | pg-boss                       | Our custom code needed?             |
| ------------------------------------ | ----------------------------- | ----------------------------------- |
| Atomic claim (SKIP LOCKED)           | Built-in                      | No                                  |
| Job expiration (hung process safety) | `expireInMinutes`             | No                                  |
| Retry with backoff                   | `retryLimit` + `retryDelay`   | No                                  |
| Dead letter queue                    | Automatic                     | No                                  |
| Completed job cleanup                | `deleteAfterDays` (default 7) | No                                  |
| Cron scheduling                      | `boss.schedule()`             | No (but available for log rotation) |
| Schema management                    | Auto-creates `pgboss` schema  | No                                  |

### What We Still Write

| Module                | Purpose                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| `execution-runner.ts` | Process spawning, log writing, safety checks                                         |
| `safety.ts`           | Working dir validation, env stripping, arg validation                                |
| `log-writer.ts`       | File-based log streaming                                                             |
| `heartbeat.ts`        | Per-execution 30s heartbeat (pg-boss handles queue-level, we handle execution-level) |

### Per-Agent Concurrency

pg-boss `teamSize` controls per-worker concurrency. Per-agent concurrency (`agents.max_concurrent`) is enforced by a pre-send check in the API layer: count running executions for the agent before enqueuing. If at limit, return 429.

### Stale Job Recovery

pg-boss has built-in expiration (`expireInMinutes`). Additionally, our zombie reconciliation on worker startup (see §11) handles crashed processes. The separate stale-reaper module from the original design is **no longer needed** — pg-boss covers this.

---

## 6. SSE Architecture

SSE replaces Supabase Realtime. Two endpoints serve different purposes.

### Log Streaming: `GET /api/executions/:id/logs/stream`

Real-time log tailing for a single execution via `fs.watch` (Linux inotify) with 500ms polling fallback. On file growth, reads new bytes from last offset and sends as SSE events.

**Event schema** (discriminated union, shared server and client):

```typescript
type SseLogEvent =
  | { type: 'status'; status: ExecutionStatus }
  | { type: 'catchup'; content: string }
  | { type: 'log'; content: string; stream: 'stdout' | 'stderr' | 'system' }
  | { type: 'done'; status: ExecutionStatus; exitCode: number | null }
  | { type: 'error'; message: string };
```

**Lifecycle**: connect -> catch-up existing content -> if terminal, send `done` and close -> otherwise watch file + poll status every 1s -> on terminal, flush final bytes, send `done`, close -> on disconnect, clean up watchers/timers.

**Required headers**: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no` (critical: disables nginx buffering).

### Board Updates: `GET /api/sse/board`

Live Kanban board updates. Poll DB every 2s. Later: upgrade to Postgres LISTEN/NOTIFY.

---

## 7. Execution Safety

All checks enforced in the worker before spawning any child process.

### 7.1 spawn(shell: false)

Every child process spawned with `shell: false`. Arguments passed as separate `argv` elements. Never construct shell command strings.

### 7.2 Argument Validation

- Template args validated against `args_schema` (JSON Schema) using Zod before interpolation
- Flag injection prevention: `args_schema` should include `pattern` constraints (e.g., branch: `^[a-zA-Z0-9/_.-]+$`)
- Object/array values in template token positions rejected

### 7.3 Working Directory Validation

Resolved `working_dir` must be:

1. Absolute path
2. Within allowlist (`ALLOWED_WORKING_DIRS` env var)
3. Existing on disk
4. Resolved through `realpathSync` BEFORE allowlist check (prevents symlink traversal)

Validated at both capability registration and execution time.

### 7.4 Environment Variable Stripping

Worker constructs minimal environment from scratch via allowlist. Does NOT spread `process.env`.

- Always allowed: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`, `TZ`
- Per-agent additions: `agents.env_allowlist` (e.g., `["ANTHROPIC_API_KEY"]`)

### 7.5 Output Limits

`agent_capabilities.max_output_bytes` (default 10MB). On exceed: `SIGTERM`, status `failed`, reason "Output limit exceeded". Output is NOT silently truncated.

### 7.6 Timeouts

`agent_capabilities.timeout_sec` (default 300s). On timeout: `SIGTERM` -> 5s -> `SIGKILL`. Status: `timed_out`.

### 7.7 Danger Levels & MCP Annotations

| Level | Meaning     | UI behavior                   |
| ----- | ----------- | ----------------------------- |
| 0     | Safe        | No confirmation               |
| 1     | Caution     | Yellow indicator              |
| 2     | Dangerous   | Confirmation dialog           |
| 3     | Destructive | Confirmation + warning banner |

MCP compatibility: `danger_level` maps to MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`). Level 0 = readOnly, level 2-3 = destructive. Later: store full MCP annotations on capabilities for interop with MCP clients. See `research-cli-discovery.md` §1.

### 7.8 Binary Path Validation

At registration: `accessSync(path, constants.X_OK)`. `kind = 'builtin'` binaries immutable; `kind = 'custom'` must be in permitted directory.

### 7.9 Network Access

Ports 4100 (web) and 4101 (terminal WebSocket) must NOT be publicly accessible without authentication. Options (preference order):

1. Bind `127.0.0.1` only; access via SSH tunnel
2. HTTP Basic Auth in nginx (covers both ports)
3. Single-user session token in Next.js proxy (`proxy.ts` -- replaces `middleware.ts` in Next.js 16)

The terminal WebSocket server has an additional JWT auth layer (see §19) -- but this protects against unauthorized terminal access, not network-level exposure.

Not blocking for development; required before internet exposure.

---

## 8. Log Strategy

- **Storage**: Raw output to `/data/agent-monitor/logs/{execution_id}.log`. Append-mode `createWriteStream`. stdout/stderr interleaved. No `fsync` per write.
- **Metadata**: Path, byte size, line count on `executions` table (no separate `execution_logs` table). Batch-updated every 5s or 1000 lines.
- **Serving**: `GET /api/executions/:id/logs` (full file), `GET /api/executions/:id/logs/stream` (SSE tail)
- **Rotation**: Cron deletes log files older than 30 days. DB records retained for history.

---

## 9. API Routes

| Resource           | Routes                                                                              |
| ------------------ | ----------------------------------------------------------------------------------- |
| **Agents**         | `GET/POST /api/agents`, `GET/PATCH/DELETE /api/agents/[id]`                         |
| **Capabilities**   | `GET/POST /api/agents/[id]/capabilities`, `PATCH/DELETE .../[capId]`                |
| **Tasks**          | `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/[id]`                           |
| **Task ops**       | `POST /api/tasks/[id]/reorder`, `POST/DELETE /api/tasks/[id]/dependencies`          |
| **Executions**     | `GET/POST /api/executions`, `GET /api/executions/[id]`                              |
| **Execution ops**  | `POST .../[id]/cancel` (202), `GET .../[id]/logs`, `GET .../[id]/logs/stream` (SSE) |
| **Terminal**       | `POST /api/terminal/token` (issue JWT for WebSocket auth)                           |
| **Infrastructure** | `GET /api/workers/status`, `GET /api/sse/board` (SSE)                               |

### Response Contract

All endpoints return `{ data: T }` (single), `{ data: T[], meta: { total, page, pageSize } }` (list), or `{ error: { code, message, context? } }` (error). All handlers wrapped in `withErrorBoundary`: `AppError` subclasses map to HTTP status, `ZodError` returns 422, unknown errors return 500 (never exposes internals).

---

## 10. Configuration

### Tier 1: Env Vars (deploy-time, requires PM2 restart)

Zod-validated at import time in `src/lib/config.ts`. Process exits on invalid config. Key vars: `DATABASE_URL`, `WORKER_ID`, `WORKER_POLL_INTERVAL_MS` (default 2000), `WORKER_MAX_CONCURRENT_JOBS` (default 3), `LOG_DIR` (default `/data/agent-monitor/logs`), `STALE_JOB_THRESHOLD_MS` (default 120000), `HEARTBEAT_INTERVAL_MS` (default 30000), `ALLOWED_WORKING_DIRS` (default `/home/ubuntu/projects:/tmp`), `NODE_ENV`, `PORT` (default 4100), `TERMINAL_WS_PORT` (default 4101), `JWT_SECRET` (required for terminal auth), `MCP_SERVER_PATH` (path to built MCP server entry point).

### Tier 2: `worker_config` DB Table (runtime-tunable)

Key-value table re-read periodically (or on SIGHUP). DB value takes precedence over env. Enables runtime tuning without PM2 restart.

---

## 11. Worker Architecture

### Module Structure

```
src/lib/worker/
├── queue.ts              # pg-boss setup, job registration, send helpers
├── execution-runner.ts   # Resolve args -> select adapter -> track -> finalize
├── log-writer.ts         # FileLogWriter: createWriteStream + byte/line tracking
├── safety.ts             # validateWorkingDir, buildChildEnv, validateArgs, validateBinary
├── heartbeat.ts          # Per-execution 30s heartbeat timer
└── adapters/
    ├── types.ts           # AgentAdapter interface definition
    ├── claude-adapter.ts  # stream-json bidirectional (NDJSON stdin/stdout)
    ├── codex-adapter.ts   # app-server JSON-RPC bidirectional
    ├── gemini-adapter.ts  # tmux send-keys / capture-pane
    └── template-adapter.ts # Simple spawn for CLI tools (git, docker, etc.)

src/lib/mcp/
├── server.ts             # MCP server implementation (tools: create_task, etc.)
└── transport.ts          # stdio + HTTP transport setup

src/terminal/
└── server.ts             # WebSocket terminal server entry point (port 4101)

src/worker/
└── index.ts              # Entry point: pg-boss.work() + signal handlers
```

Note: `job-claimer.ts` and `stale-reaper.ts` from the original design are replaced by pg-boss internals.

### Agent Adapter Interface

All adapters implement a common interface:

```typescript
interface AgentAdapter {
  spawn(prompt: string, opts: SpawnOpts): ManagedProcess;
  resume(sessionRef: string, prompt: string, opts: SpawnOpts): ManagedProcess;
  extractSessionId(output: string): string | null;
  sendMessage?(message: string): void; // Multi-turn (Claude, Codex only)
  interrupt?(): void; // Cancel current turn
}

interface ManagedProcess {
  pid: number;
  tmuxSession: string; // All agents run in tmux
  kill: (signal: NodeJS.Signals) => void;
  onData: (cb: (chunk: string) => void) => void;
  onExit: (cb: (code: number | null) => void) => void;
}
```

The `execution-runner.ts` selects the adapter based on `agent_capabilities.interaction_mode` and the agent's binary name. Template mode always uses `template-adapter`. Prompt mode selects `claude-adapter`, `codex-adapter`, or `gemini-adapter` based on a preset lookup.

### Build Strategy

| Mode        | Tool                            | Output                       |
| ----------- | ------------------------------- | ---------------------------- |
| Development | `tsx watch src/worker/index.ts` | Direct TS execution          |
| Production  | `tsc -p tsconfig.worker.json`   | `dist/worker/index.js` (CJS) |

### Testability

Injectable `ProcessSpawner` interface:

```typescript
interface ProcessSpawner {
  spawn(binary, args, options, onData, onExit): { pid: number; kill: (signal) => void };
}
```

Production: real `child_process.spawn`. Tests: mock spawner.

### Startup: Zombie Reconciliation

On cold start (before poll loop):

1. Query `WHERE status IN ('running', 'cancelling') AND worker_id = $myWorkerId`
2. Check PID alive: `process.kill(pid, 0)`
3. Dead PID -> mark `failed` with "Worker restarted, execution orphaned"
4. Live PID (rare after restart) -> send SIGTERM, handle normally

### Startup: Disk Space Check

Before poll loop: if free space < 5GB, log warning and refuse to claim new jobs.

### Graceful Shutdown (SIGTERM)

1. Stop claiming new jobs
2. SIGTERM all running children
3. Wait up to 10s for exit
4. SIGKILL remaining children
5. Update owned executions to `failed` with "Worker shutdown"
6. Exit

---

## 12. Execution Data Flow

```
 1. User clicks "Run" on task, selects capability, fills args form
    -> Browser validates args (Zod from args_schema)
    -> POST /api/executions { task_id, capability_id, args }

 2. API route:
    -> Re-validate args server-side, validate working_dir in allowlist
    -> Insert execution status='queued', insert task_event
    -> If task.status == 'todo', update to 'in_progress'
    -> Return { data: { id: executionId } }

 3. Browser opens SSE: GET /api/executions/:id/logs/stream
    -> Handler sends keepalive until log file exists

 4. pg-boss delivers job to worker (SKIP LOCKED internally)
    -> Sets running, stores worker_id, starts heartbeat

 5. Worker spawns child inside tmux session:
    -> Creates tmux session "exec-{id}", enables pipe-pane to log file
    -> Template: spawn(binary, args) inside tmux, stdin ignored
    -> Prompt: selects adapter (claude/codex/gemini), starts bidirectional session
    -> Stores PID and tmux session name in DB

 6. On stdout/stderr data -> write to log file, batch-update DB metadata every 5s

 7. SSE handler detects file changes via fs.watch
    -> Reads new bytes, sends { type: 'log', content, stream }

 8. On process exit:
    -> Flush log, clear heartbeat, update execution status/exit_code/ended_at
    -> Insert task_event 'execution_completed'

 9. SSE handler detects terminal status
    -> Flush final bytes, send { type: 'done' }, close stream

10. Browser receives 'done', closes EventSource, updates UI
```

**Timing notes**: Queued-to-running has ~2s delay (poll interval). Log metadata batched every 5s (no correctness impact -- SSE reads file directly). Execution start auto-moves task `todo` -> `in_progress`; execution success does NOT auto-move to `done` (task may have multiple executions). User can click "Attach Terminal" at any point during steps 5-9 to get interactive access via WebSocket terminal (see §19).

---

## 13. State Machines

Transition tables enforced in service layer. Invalid transitions rejected with 409 Conflict.

### Task Status

```
todo        -> in_progress, cancelled, blocked
in_progress -> done, blocked, cancelled, todo
blocked     -> todo, in_progress, cancelled
done        -> todo (reopen)
cancelled   -> todo (reopen)
```

### Execution Status

```
queued     -> running, cancelled
running    -> cancelling, succeeded, failed, timed_out
cancelling -> cancelled, failed
succeeded  -> (terminal)
failed     -> (terminal)
cancelled  -> (terminal)
timed_out  -> (terminal)
```

The API can only set `cancelling`. All other execution transitions are owned by the worker.

---

## 14. Error Handling

```
AppError (base)
├── NotFoundError (404)
├── ValidationError (422)
├── ConflictError (409)       -- invalid transitions, cycle detection
├── SafetyViolationError (403) -- working dir violation, binary not found
└── TimeoutError (408)
```

| Context    | Behavior                                                                                |
| ---------- | --------------------------------------------------------------------------------------- |
| API routes | `withErrorBoundary` maps to HTTP status + JSON envelope                                 |
| Worker     | `finalizeWithError` writes one-line summary to `executions.error`, sets terminal status |
| SSE        | Terminal status + one-line error in `done` event; full log via download                 |

---

## 15. Scaling Constraints (4 CPU / 16 GB RAM)

Next.js: 200-400 MB (limit 1G). Worker: 50-100 MB (limit 512M). Terminal server: 50-100 MB (limit 256M). Postgres: 200-400 MB. Each Claude execution: 150-300 MB. Each CLI execution: 50-100 MB. tmux per session: ~5-10 MB. node-pty per connection: ~1-2 MB. Existing PM2 apps: 3-6 GB. Available for agent-monitor: ~6-8 GB.

### Concurrency & Connections

- 3 concurrent Claude Code sessions: ~900 MB - 1.2 GB. CPU (not memory) is the binding constraint: 3 sessions pin all 4 cores.
- Default `WORKER_MAX_CONCURRENT_JOBS = 3`
- Postgres pool: 10 connections via `node-postgres`. SSE polls briefly every 1s, does not hold connections.
- Terminal WebSocket connections: lightweight (text frames, no binary encoding overhead). Each active terminal: ~10-15 MB (node-pty + tmux client + xterm.js scrollback on client side).

---

## 16. Project Structure

Single package, flat layout. No monorepo. See 04-phases.md for complete file-by-phase reference.

| Directory                  | Purpose                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/app/`                 | Next.js App Router: `(dashboard)/` pages, `api/` routes                                                 |
| `src/components/`          | UI: `ui/` (shadcn), `layout/`, `tasks/`, `agents/`, `executions/`, `forms/`, `dashboard/`, `terminal/`  |
| `src/lib/db/`              | `index.ts` (Drizzle singleton, pg pool max:10), `schema.ts` (see 03-data-model.md)                      |
| `src/lib/services/`        | Business logic (CRUD, validation, state transitions)                                                    |
| `src/lib/actions/`         | Next.js Server Actions (mutations from client)                                                          |
| `src/lib/discovery/`       | Auto-discovery pipeline (scanner, classifier, schema-extractor, presets)                                |
| `src/lib/worker/`          | Testable worker modules (queue/pg-boss, runner, safety, heartbeat)                                      |
| `src/lib/worker/adapters/` | Per-agent adapters: `claude-adapter.ts`, `codex-adapter.ts`, `gemini-adapter.ts`, `template-adapter.ts` |
| `src/lib/mcp/`             | MCP server implementation (`server.ts`, `transport.ts`) — agents call back into Agent Monitor           |
| `src/lib/hooks/`           | Client-only SSE hooks                                                                                   |
| `src/lib/store/`           | Client-only Zustand stores                                                                              |
| `src/lib/` (root)          | `config.ts`, `errors.ts`, `state-machines.ts`, `api-handler.ts`, `api-types.ts`, `types.ts`             |
| `src/terminal/`            | WebSocket terminal server entry point (`server.ts`) — standalone process on port 4101                   |
| `src/worker/`              | Worker process entry point (`index.ts`)                                                                 |

### Structural Rules

1. **`src/lib/` is shared** -- imported by both Next.js and worker. No `"use client"` inside. No `next/headers` in `src/lib/worker/`.
2. **No barrel `index.ts` files** in `src/lib/`. Barrel files cause Next.js to bundle Node-only code into browser chunks.
3. **`src/lib/store/` and `src/lib/hooks/` are client-only**. Worker never imports from these.

---

## 17. Agent Auto-Discovery

**Decision**: No manual registration. Agents are discovered automatically on startup and on-demand. User confirms/rejects discovered tools via a "Scan & Confirm" UI flow.

See `research-auto-discovery.md` (1073 lines) and `research-cli-tool-testing.md` (631 lines) for full analysis.

### 6-Stage Pipeline

```
SCAN → IDENTIFY → CLASSIFY → SCHEMA → ENRICH → INDEX
```

| Stage       | What                                            | How                                                                  | Cost         |
| ----------- | ----------------------------------------------- | -------------------------------------------------------------------- | ------------ |
| 1. SCAN     | Find all executables in PATH                    | `readdir()` on each PATH dir, check `X_OK`                           | ~200ms, free |
| 2. IDENTIFY | Map binary → package/source                     | `dpkg -S`, `apt-cache show`, `file` command                          | ~5ms/tool    |
| 3. CLASSIFY | CLI tool / daemon / AI agent / TUI / shell-util | Man page section, systemd check, name patterns                       | ~8ms/tool    |
| 4. SCHEMA   | Extract subcommands, flags, args                | Fig specs → bash-completion → regex --help parse → LLM (last resort) | Variable     |
| 5. ENRICH   | Version, aliases, usage frequency               | `--version`, shell history count, alias scan                         | ~10ms/tool   |
| 6. INDEX    | Store in DB as agent + capabilities             | Insert into `agents` + `agent_capabilities`                          | DB write     |

### Schema Sources (priority order)

1. **Fig specs** (500+ tools) — `withfig/autocomplete` repo, TypeScript objects with full CLI schemas
2. **argc-completions** (1000+ tools) — `sigoden/argc-completions`, cross-shell completion definitions
3. **Bash completion files** (912 on this system) — `/usr/share/bash-completion/completions/`, extractable patterns
4. **Regex --help parse** (free, fast) — Pattern matching on `--help` output for flags and subcommands
5. **LLM --help parse** (last resort) — Send help text to AI with structured output schema; only for priority tools

### Known AI Tool Presets

Rather than discovering AI agents purely from `--help`, use hardcoded presets for known tools:

| Tool        | Binary   | Adapter             | Protocol                             | Session Resume                        | Session ID Source                      |
| ----------- | -------- | ------------------- | ------------------------------------ | ------------------------------------- | -------------------------------------- |
| Claude Code | `claude` | `claude-adapter.ts` | `stream-json` bidirectional (NDJSON) | `--resume <uuid>`, `--continue`       | `system.init` event `session_id` field |
| Codex CLI   | `codex`  | `codex-adapter.ts`  | `app-server` JSON-RPC bidirectional  | `thread/resume` with threadId         | `thread/start` response `thread.id`    |
| Gemini CLI  | `gemini` | `gemini-adapter.ts` | tmux send-keys / capture-pane        | `--resume latest`, `--resume <index>` | `--list-sessions` parse or filesystem  |

Presets are stored in `src/lib/discovery/presets.ts` and matched by binary name during SCAN.

### Performance Budget

Stages 1-3 run for ALL tools (~20s for ~1500 binaries). Stage 4 runs ONLY for:

- Tools the user has in shell history (frequent use signal)
- AI tool presets (always)
- On-demand when user selects a tool in the UI

Stage 5 (LLM parse) runs ONLY when regex parse finds 0 options/subcommands AND the tool is in the user's favorites.

### Scan Triggers

1. **Worker startup** — full scan, store results in DB
2. **Manual rescan** — user clicks "Rescan" button in UI
3. **On-demand** — when user searches for a tool not in registry

### "Scan & Confirm" UI Flow

1. Discovery pipeline runs → produces list of discovered tools
2. UI shows discovered tools with categories, descriptions, confidence indicators
3. User confirms (activates) tools they want, ignores/hides the rest
4. Confirmed tools become active agents with auto-generated capabilities
5. User can later edit, add custom capabilities, or re-scan

---

## 18. Session Management (CLI-Based, Bidirectional)

**Decision**: No embedded SDKs, no API keys. All AI tools managed as CLI subprocesses inside tmux sessions. Each agent has a dedicated adapter for its native protocol. Session IDs captured from protocol-specific output and stored for resume.

See `research-session-management.md` (921 lines), `research-bidirectional-agents.md` (1730 lines), and `research-claude-headless-protocol.md` (1629 lines) for full analysis.

### Why CLI-Only (Not Agent SDK or Direct APIs)

`@anthropic-ai/claude-agent-sdk` requires an **Anthropic API key** -- it uses API billing, not the user's Claude Pro/Max subscription. Same for direct Anthropic Messages API, OpenAI API, or Google Gemini API. Agent Monitor must use the **CLI binaries with the user's existing OAuth/login** so there are zero additional API costs.

Additionally:

- SDK/API bypasses the CLI's built-in tools (Read, Write, Bash, Glob, Grep)
- SDK/API has no session persistence (the CLI manages sessions on disk)
- Using SDK for Claude but subprocess for Gemini/Codex creates inconsistency
- The CLI `stream-json` and `app-server` protocols provide full bidirectional communication without needing the SDK

The CLI approach is the only one that uses the user's existing subscription, provides full tool access, and supports all three agents uniformly.

### Per-Agent Adapters

All adapters implement the `AgentAdapter` interface (see §11). Each adapter manages its agent's specific protocol while presenting a uniform interface to the execution runner.

#### Claude Code Adapter (`stream-json` bidirectional)

Uses `--input-format stream-json` and `--output-format stream-json` for NDJSON bidirectional communication over stdin/stdout. The process runs inside a tmux session.

```
Spawn: claude -p --input-format stream-json --output-format stream-json
       --verbose --permission-mode bypassPermissions
       --max-budget-usd 5.00 --max-turns 50

Stdin (NDJSON):  {"type":"user","message":{"role":"user","content":"..."},
                  "session_id":"default","parent_tool_use_id":null}

Stdout events:   system (init, session_id) -> assistant (text + tool_use)
                 -> stream_event (partial tokens) -> result (final, cost, usage)

Multi-turn:      Send additional {"type":"user",...} messages at any time.
Resume:          Add --resume <sessionId> to spawn flags.
```

**Key flags**: `--verbose` (required for full output), `--include-partial-messages` (token streaming), `--max-budget-usd` (cost cap), `--max-turns` (turn limit), `--allowedTools` (tool restrictions).

#### Codex CLI Adapter (`app-server` JSON-RPC bidirectional)

Uses `codex app-server` which provides a JSON-RPC protocol over stdio. The most complete bidirectional protocol of the three agents.

```
Spawn:         codex app-server

Handshake:     -> initialize (request) -> initialized (notification)
Start thread:  -> thread/start { model, cwd, approvalPolicy, sandbox }
Send turn:     -> turn/start { threadId, input: [{ type:"text", text }] }
Steer mid-turn:-> turn/steer { threadId, turnId, input: [...] }
Interrupt:     -> turn/interrupt { threadId, turnId }

Events:        <- item/agentMessage/delta, turn/completed,
                  item/commandExecution/requestApproval, turn/diff/updated

Resume:        -> thread/resume { threadId } (stored threadId from DB)
```

**Fallback** for simple one-shot: `codex exec -C <cwd> "prompt"` (no bidirectional).

#### Gemini CLI Adapter (tmux send-keys / capture-pane)

Gemini CLI has **no native bidirectional protocol**. Uses tmux as the communication layer.

```
Spawn:     gemini -i "initial prompt"  (inside tmux session)
Send:      tmux send-keys -t "exec-{id}" -l "message text" && Enter
Read:      tmux capture-pane -t "exec-{id}" -p -S -1000
           OR: pipe-pane to log file, tail the file
Detect:    Poll for ">" prompt to detect completion (heuristic)
Resume:    --resume latest or --resume <index>
List:      --list-sessions -> parse "N. Title (time) [uuid]"
```

**Limitation**: No structured event stream. Output is raw terminal text with ANSI codes. Completion detection is prompt-based (heuristic). This is inherently less reliable than Claude's NDJSON or Codex's JSON-RPC.

### Session Storage

Session IDs stored on `executions.session_ref`. Enables:

- "Continue" button on completed executions
- Session history per task (chain of `session_ref` values)
- `parentExecutionId` links related executions (continuation chain)

### Session File Locations (for filesystem monitoring)

```
Claude:  ~/.claude/projects/<project-slug>/<uuid>.jsonl
Gemini:  ~/.gemini/tmp/<project-hash>/chats/session-<date>-<uuid-prefix>.json
Codex:   ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<datetime>-<uuid>.jsonl
```

### Session Resume UI

- Execution detail view shows "Continue Session" button (if `session_ref` exists)
- Creates new execution linked to original via `parentExecutionId`
- Kanban card shows session chain indicator (e.g., "3 turns")

---

## 19. Web Terminal

The execution detail view has two modes: a default **SSE log viewer** (read-only, lightweight) and an on-demand **interactive web terminal** (full xterm.js, heavy).

See `research-web-terminal.md` (927 lines) for full analysis of xterm.js v6, node-pty, WebSocket patterns, tmux integration, and security considerations.

### Default: SSE Log Viewer (Read-Only)

The SSE endpoint (`GET /api/executions/:id/logs/stream`) streams log output as text. No WebSocket, no PTY, no xterm.js. This is the lightweight default for monitoring running agents.

### On-Demand: Interactive Web Terminal

When the user clicks "Attach Terminal" on a running execution:

1. Browser loads xterm.js (dynamically imported, SSR-safe)
2. Connects via WebSocket to `ws://host:4101?token=JWT&session=TMUX_SESSION_NAME`
3. Terminal server spawns `tmux attach-session -t <session>` via node-pty
4. User gets full interactive terminal access to the running agent
5. When user closes tab or disconnects, the tmux session (and agent) keeps running

### Architecture

```
Browser                          Terminal Server (:4101)         tmux
┌──────────┐  WebSocket (JWT)   ┌──────────────────┐           ┌──────────┐
│ xterm.js │ ◄──────────────► │ ws + node-pty     │ ──PTY──► │ tmux     │
│ v6       │                   │ per-session mgr   │  attach   │ session  │
└──────────┘                   └──────────────────┘           │ ┌──────┐ │
                                                               │ │claude│ │
                                                               │ └──────┘ │
                                                               └──────────┘
```

### Terminal Server (`src/terminal/server.ts`)

Standalone Node.js process on port 4101. Not embedded in Next.js.

- **WebSocket server** (`ws` library) — handles connection upgrade, JWT validation, session routing
- **Session manager** — maps session IDs to node-pty instances, tracks connected clients
- **Multi-viewer** — multiple browser tabs can connect to the same tmux session simultaneously
- **Graceful detach** — when last client disconnects, PTY process exits (tmux detaches), agent continues
- **Resize** — client sends resize control messages, forwarded to PTY via `pty.resize(cols, rows)`

### JWT Authentication

Terminal WebSocket connections require a short-lived JWT token:

1. Browser requests token via `POST /api/terminal/token` (Next.js API route, session-authenticated)
2. Server issues JWT with claims: `{ sessionName, userId, exp: now + 5min }`
3. Browser includes token as query parameter on WebSocket connection
4. Terminal server validates JWT before accepting the upgrade
5. Token is single-use for the connection upgrade — not reusable

### xterm.js Integration

- **Package**: `@xterm/xterm` v6 (scoped packages, not deprecated `xterm`)
- **Addons**: `@xterm/addon-fit` (auto-resize), `@xterm/addon-web-links` (clickable URLs), `@xterm/addon-webgl` (GPU rendering with DOM fallback)
- **SSR safety**: Dynamic import with `ssr: false` in Next.js (xterm.js accesses `window`)
- **Custom React wrapper** (~60 lines) — no third-party wrappers (they all lag behind xterm v6)

### tmux Session Lifecycle

```
SPAWN    Worker creates tmux session, starts agent inside it
         tmux new-session -d -s "exec-{id}" -x 120 -y 40 -c {cwd}
         tmux send-keys -t "exec-{id}" "{agent_command}" Enter
         tmux pipe-pane -t "exec-{id}" -o "cat >> {log_path}"

STREAM   SSE log viewer tails the pipe-pane log file (default mode)

ATTACH   User clicks "Attach Terminal" — node-pty spawns tmux attach
         User interacts directly with the running agent

DETACH   User closes tab — PTY exits, tmux detaches
         Agent keeps running, SSE streaming resumes

EXIT     Agent completes — tmux session ends
         Worker detects exit, finalizes execution record
```

### Why tmux Is Required

| Requirement                            | Without tmux | With tmux               |
| -------------------------------------- | ------------ | ----------------------- |
| Agent survives browser close           | No           | Yes                     |
| Multiple viewers same session          | Complex      | Built-in                |
| Detach and reattach                    | Impossible   | Native                  |
| Session persists across server restart | No           | Yes (tmux-resurrect)    |
| Process isolation                      | Shared PTY   | Separate process groups |

### Performance Notes

- node-pty overhead: ~1-2MB per instance (the child process is the real cost)
- xterm.js scrollback: 5000 lines (default) — ~34MB per terminal at 160x24
- WebGL renderer: up to 900% faster than canvas (falls back to DOM if WebGL2 unavailable)
- Flow control: watermark-based backpressure between PTY output and WebSocket delivery

---

## 20. MCP Server (Agent-to-Monitor Communication)

Agent Monitor exposes an **MCP server** that AI agents connect to via `--mcp-config` or `.mcp.json`. This allows agents to create tasks, update status, spawn other agents, and report back to the board — closing the bidirectional feedback loop.

See `research-agent-task-management.md` (667 lines) for full MCP server implementation, Claude teams analysis, and multi-agent patterns.

### MCP Tools

| Tool             | Description                                           | Maps To                                 |
| ---------------- | ----------------------------------------------------- | --------------------------------------- |
| `create_task`    | Create a new task on the board                        | `POST /api/tasks`                       |
| `update_task`    | Update task status, assignee, description             | `PATCH /api/tasks/:id`                  |
| `list_tasks`     | List tasks with optional filters (status, assignee)   | `GET /api/tasks`                        |
| `create_subtask` | Break a task into subtasks                            | `POST /api/tasks` (with `parentTaskId`) |
| `assign_task`    | Assign a task to a specific agent                     | `PATCH /api/tasks/:id`                  |
| `spawn_agent`    | Request Agent Monitor to spawn a new agent for a task | `POST /api/agents/spawn`                |

### How Each Agent Connects

**Claude Code** — via `.mcp.json` in project root or `--mcp-config`:

```json
{
  "mcpServers": {
    "agent-monitor": {
      "command": "node",
      "args": ["/path/to/agent-monitor-mcp-server.js"],
      "env": { "AGENT_MONITOR_URL": "http://localhost:4100" }
    }
  }
}
```

**Codex CLI** — via `~/.codex/config.toml`:

```toml
[mcp_servers.agent-monitor]
command = "node"
args = ["/path/to/agent-monitor-mcp-server.js"]

[mcp_servers.agent-monitor.env]
AGENT_MONITOR_URL = "http://localhost:4100"
```

**Gemini CLI** — via `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "agent-monitor": {
      "command": "node",
      "args": ["/path/to/agent-monitor-mcp-server.js"],
      "env": { "AGENT_MONITOR_URL": "http://localhost:4100" }
    }
  }
}
```

### Transport Options

| Transport                  | Use Case                        | How                                                    |
| -------------------------- | ------------------------------- | ------------------------------------------------------ |
| **stdio** (default)        | Same machine, per-agent process | Agent spawns MCP server as child process               |
| **HTTP** (Streamable HTTP) | Remote access, shared server    | Single MCP server on port 4102, agents connect via URL |

Use **stdio** transport — each agent gets its own MCP server process. Later: add HTTP transport for multi-machine setups.

### Implementation: `src/lib/mcp/server.ts`

Uses `@modelcontextprotocol/sdk` with Zod schemas for input validation. Each tool is a thin wrapper that calls Agent Monitor's REST API internally:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'agent-monitor', version: '1.0.0' });

server.registerTool(
  'create_task',
  {
    title: 'Create Task',
    description: 'Create a new task on the Agent Monitor board',
    inputSchema: { title: z.string(), priority: z.enum(['low', 'medium', 'high', 'critical']) },
  },
  async ({ title, priority }) => {
    const res = await fetch(`${API_URL}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, priority, status: 'todo', createdBy: 'mcp-agent' }),
    });
    const task = await res.json();
    return { content: [{ type: 'text', text: `Task #${task.id} created` }] };
  },
);
// ... remaining tools follow same pattern
```

### Loop Prevention & Safety

When agents can spawn other agents, runaway loops are a real risk. Guards:

| Guard                      | Value                           | Purpose                                                     |
| -------------------------- | ------------------------------- | ----------------------------------------------------------- |
| **Spawn depth limit**      | 3                               | Tasks track `depth` — agent cannot spawn if task depth >= 3 |
| **Spawn cooldown**         | 30s per agent type              | Prevents rapid-fire spawning                                |
| **Max concurrent agents**  | 3                               | Hard limit on simultaneous AI agent processes               |
| **Per-agent token budget** | `--max-budget-usd 5.00`         | Claude/Codex cost cap per execution                         |
| **Per-agent max turns**    | `--max-turns 50`                | Turn limit prevents infinite loops                          |
| **Memory ceiling**         | ~2GB per agent (`NODE_OPTIONS`) | Prevents OOM on instance-neo                                |

The `spawn_agent` MCP tool checks all guards before creating the execution. If any guard fails, it returns an error message explaining the limit (not a crash).

---

## Future Considerations

### i18n / RTL Support

- **Status:** Deferred (not scheduled for any current phase)
- **Scope:** Add Hebrew (RTL) language support to the UI
- **Recommended stack:** `next-intl` (best App Router integration), locale files (`/messages/en.json`, `/messages/he.json`), middleware for locale detection, dynamic `dir="rtl"` on root layout
- **Impact:** Touches every component with user-facing text; requires RTL-aware Tailwind layout (`rtl:` variant or logical properties)
- **When:** After core UI is functional and stable. Adding i18n early would increase per-component overhead without immediate benefit for a developer tool.
