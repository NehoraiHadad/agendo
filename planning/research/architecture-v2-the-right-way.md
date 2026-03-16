# Architecture V2: The Right Way

**Date**: 2026-03-16
**Status**: Complete — all three protocol expert analyses incorporated
**Author**: Architect agent (synthesis of codebase analysis + protocol expert research)

---

## 0. The Core Question

> CLI tools have TUIs that show everything (streaming, tools, approvals, history, costs). So the data IS accessible. What is the MINIMAL, CORRECT layer Agendo needs between the CLIs and the browser?

This document answers that question by examining what each CLI protocol actually provides, what Agendo truly needs to add, what's currently redundant, and what the right architecture looks like.

---

## 1. Per-CLI Protocol Capability Matrix

### What Each Protocol Actually Provides

| Capability                   | Claude SDK                                                                                                                                                                                                        | Codex app-server                                                         | Gemini ACP                                                         | Copilot ACP                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------- |
| **Transport**                | In-process (Node.js library)                                                                                                                                                                                      | NDJSON over stdio                                                        | NDJSON over stdio                                                  | NDJSON over stdio                                    |
| **Session persistence**      | JSONL on disk (`~/.claude/projects/`) — 9 record types including progress, queue-operation, file-history-snapshot                                                                                                 | Rollout JSONL on disk                                                    | Internal (process memory)                                          | Internal (process memory)                            |
| **Resume**                   | `resume` + `resumeSessionAt` + `forkSession` + `sessionId` + `continue`                                                                                                                                           | `thread/resume` RPC                                                      | `session/load` (replays history)                                   | `--resume=<id>`                                      |
| **History read API**         | `getSessionMessages()` — parses JSONL, walks parentUuid chain, returns chronological messages. No running process needed. Also `listSessions()` for discovery.                                                    | `thread/read` with `includeTurns: true` returns full conversation        | `session/load` (replay as notifications, requires running process) | None                                                 |
| **Real-time text streaming** | `stream_event` → `content_block_delta`                                                                                                                                                                            | `item/agentMessage/delta`                                                | `sessionUpdate` callback                                           | `sessionUpdate` callback                             |
| **Thinking/reasoning**       | `thinking_delta` via `stream_event`                                                                                                                                                                               | `item/reasoning/summaryTextDelta`                                        | Not exposed                                                        | Not exposed                                          |
| **Tool start/end**           | `assistant` (tool_use blocks) + `user` (tool_result blocks)                                                                                                                                                       | `item/started` + `item/completed`                                        | `tool_call` + `tool_call_update` via `sessionUpdate`               | `tool_call` + `tool_call_update` via `sessionUpdate` |
| **Cost tracking**            | `result.total_cost_usd` + per-model `modelUsage[].costUSD` + budget cap (`maxBudgetUsd`)                                                                                                                          | None                                                                     | None                                                               | None                                                 |
| **Token usage**              | `stream_event.message_start.usage` (per-call: input, output, cache read/creation, web search) + per-model `modelUsage[].inputTokens/outputTokens/cacheReadInputTokens/cacheCreationInputTokens/webSearchRequests` | `thread/tokenUsage/updated`                                              | Not exposed via ACP                                                | Not exposed via ACP                                  |
| **Context window size**      | `result.modelUsage[model].contextWindow` + `maxOutputTokens` per model                                                                                                                                            | `modelContextWindow` in token usage (currently hardcoded 200K in Agendo) | Not exposed                                                        | Not exposed                                          |
| **Approval mechanism**       | `canUseTool` callback (in-process)                                                                                                                                                                                | `requestApproval` server→client RPC                                      | `requestPermission` ACP callback                                   | `requestPermission` ACP callback                     |
| **Model switching**          | `setModel()`                                                                                                                                                                                                      | `setDefaultModel` RPC                                                    | Kill + respawn (no in-place)                                       | `unstable_setSessionModel` ACP                       |
| **Permission mode**          | `setPermissionMode()`                                                                                                                                                                                             | Stored locally, applied per-turn                                         | `session/setMode` ACP                                              | `session/setMode` ACP                                |
| **MCP management**           | `setMcpServers()`, `reconnectMcpServer()`, `toggleMcpServer()`, `mcpServerStatus()` + in-process `createSdkMcpServer()` (direct function calls, no stdio)                                                         | `config/batchWrite` + `mcpServerStatus/list`                             | `session/new` mcpServers param                                     | `--additional-mcp-config`                            |
| **Compaction**               | `compact_boundary` system event (with `compact_metadata: {trigger, pre_tokens}`) + `status: 'compacting'`                                                                                                         | `thread/compact/start` + `contextCompaction` item                        | Not exposed                                                        | Not exposed                                          |
| **File rewind**              | `rewindFiles(messageId)` — checkpoint-based rewind of file changes                                                                                                                                                | Not available                                                            | Not available                                                      | Not available                                        |
| **Slash commands**           | `supportedCommands()`                                                                                                                                                                                             | `skills/list` RPC                                                        | TOML scanning (filesystem)                                         | Not available                                        |
| **Subagents**                | Programmatic `agents` option (custom definitions with model/tools/prompt) + `task_started`/`task_progress`/`task_notification` events                                                                             | Not exposed                                                              | Not exposed                                                        | Not exposed                                          |
| **Hooks**                    | 21 in-process hook events (PreToolUse, PostToolUse, Stop, SubagentStart, etc.) — TypeScript callbacks                                                                                                             | Not available                                                            | Not available                                                      | Not available                                        |
| **Structured output**        | `outputFormat` (JSON schema) for forced structured responses                                                                                                                                                      | Not available                                                            | Not available                                                      | Not available                                        |
| **Budget enforcement**       | `maxBudgetUsd` + `maxTurns` per query                                                                                                                                                                             | Not available                                                            | Not available                                                      | Not available                                        |
| **Prompt suggestions**       | `promptSuggestions` → predicted next user prompts                                                                                                                                                                 | Not available                                                            | Not available                                                      | Not available                                        |
| **Steer (mid-turn)**         | Not available                                                                                                                                                                                                     | `turn/steer` RPC                                                         | Not available                                                      | Not available                                        |
| **Rollback**                 | Not available (use `resumeSessionAt`)                                                                                                                                                                             | `thread/rollback` RPC                                                    | Not available                                                      | Not available                                        |
| **Conversation branching**   | `parentUuid` tree in JSONL                                                                                                                                                                                        | `thread/fork`                                                            | `session/fork`                                                     | Not available                                        |
| **Plan mode**                | Native `ExitPlanMode` tool                                                                                                                                                                                        | `turn/planUpdated` + plan items                                          | `--approval-mode plan` (CLI only, not ACP)                         | Not available                                        |
| **Rate limiting**            | `rate_limit_event` SDKMessage                                                                                                                                                                                     | Not exposed                                                              | Not exposed                                                        | Not exposed                                          |
| **Service tier/geo**         | In `result.usage` extensions                                                                                                                                                                                      | Not exposed                                                              | Not exposed                                                        | Not exposed                                          |

### Key Observations From the Matrix

1. **Claude SDK is the richest by far**: cost tracking, per-model usage breakdown, context window size, rate limits, service tier, file rewind, native MCP management, conversation branching via parentUuid. No other CLI provides even half of this.

2. **Codex app-server is the most interactive**: steer (mid-turn injection), rollback, structured thread management, plan streaming. But lacks cost/token/context data.

3. **ACP (Gemini/Copilot) is the most uniform**: identical protocol for two agents. But the thinnest — no cost, no token usage, no context window, no history read API, no compaction control.

4. **No CLI provides a browser-accessible transport**: All four use either in-process callbacks (Claude) or stdio NDJSON (Codex, Gemini, Copilot). A server-side mediator is architecturally mandatory.

5. **No CLI provides Agendo's session state machine**: active/awaiting_input/idle/ended is entirely Agendo's concept. The CLIs have no equivalent.

---

## 2. What Agendo Truly Needs to Add (The Irreducible Minimum)

These are capabilities that NO CLI provides and that are essential to Agendo's value proposition:

### 2.1 Mandatory Agendo Layer (cannot be eliminated)

| #   | Capability                        | Why It's Irreducible                                                                   | Current Implementation                           |
| --- | --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | **Browser-accessible transport**  | CLIs use stdio/in-process. Browser needs SSE/WebSocket.                                | SSE via `events/route.ts`                        |
| 2   | **Unified event format**          | 4 CLIs with 4 different event formats. UI needs one.                                   | `AgendoEventPayload` (29 types)                  |
| 3   | **Session state machine**         | active/awaiting_input/idle/ended. No CLI has this.                                     | `SessionProcess.transitionTo()`                  |
| 4   | **Tool approval UI bridge**       | Each CLI has its own approval mechanism (callback/RPC/ACP). Need to bridge to browser. | `ApprovalHandler` + `agent:tool-approval` events |
| 5   | **Bidirectional control channel** | User messages, cancel, interrupt, tool approvals from browser → worker → agent.        | PG NOTIFY control channel                        |
| 6   | **Job scheduling & concurrency**  | Queue sessions, limit concurrent agents, auto-resume on crash.                         | pg-boss `run-session` queue                      |
| 7   | **Multi-agent team coordination** | Team inbox monitoring, cross-agent messaging, task assignment.                         | `SessionTeamManager` + `team:*` events           |
| 8   | **MCP server injection**          | Dynamic MCP config per session (the Agendo MCP server itself).                         | `session-runner.ts` builds MCP config            |
| 9   | **Idle timeout & heartbeat**      | Detect stale sessions, kill idle agents, auto-resume.                                  | `ActivityTracker`                                |
| 10  | **Event replay on reconnect**     | Browser refresh needs full event history.                                              | Log file + SSE catchup                           |
| 11  | **Subagent tracking**             | Claude spawns subagents; Agendo tails their JSONL for progress.                        | `subagent:*` events                              |

### 2.2 Valuable Enrichments (CLI data is incomplete)

| #   | Enrichment                     | Why CLIs Don't Cover It                                                             | Current Implementation             |
| --- | ------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | **Cost normalization**         | Only Claude provides cost. Codex/Gemini/Copilot: none.                              | `agent:result.costUsd`             |
| 2   | **Context window metrics**     | Only Claude provides `contextWindow`. Others: estimated.                            | `agent:usage` events               |
| 3   | **User message recording**     | CLIs store user messages in their own format. Agendo's log is the unified timeline. | `user:message` events              |
| 4   | **MCP health monitoring**      | Periodic health checks detect disconnected MCP servers.                             | `system:mcp-status` events         |
| 5   | **Permission denial tracking** | Only Claude provides this natively.                                                 | `agent:result.permissionDenials`   |
| 6   | **Per-call context stats**     | Accurate per-API-call context usage (vs aggregated turn stats). Claude only.        | `agent:result.perCallContextStats` |

---

## 3. What's Currently Redundant

### 3.1 Conversation Content Duplication

The core conversation (agent text, tool calls, tool results) is stored in THREE places:

1. **CLI native storage** (Claude JSONL, Codex rollout, Gemini internal)
2. **Agendo log file** (the event stream on disk)
3. **PG NOTIFY** (ephemeral, no durability)

**Is this redundant?** Partially. The CLI native storage and Agendo log both contain the conversation. However:

- CLI native formats are all different (not directly usable by the browser)
- Agendo's log includes ~50% Agendo-generated events (state machine, team, approval, usage) that don't exist in CLI storage
- The log file is optimized for sequential replay (pre-serialized NDJSON)

**Verdict**: The log file is NOT redundant — it's the unified, enriched event store. The CLI native storage is supplementary (useful for resume, branching, debugging).

### 3.2 PG NOTIFY as the Live Event Bus

PG NOTIFY adds:

- 1 DB query per event (`SELECT pg_notify()`)
- 1 DB query per event (`UPDATE sessions SET eventSeq`)
- 20-connection dedicated listener pool
- 7500-byte payload limit (ref-stub workaround)

The log file already contains every event. PG NOTIFY's role is purely "wake up the SSE endpoint to read the new log entry." This is the definition of a notification pattern — the notification doesn't need to carry the full payload.

**Verdict**: PG NOTIFY is doing too much work. It's carrying full event payloads when a simple "new event available" ping would suffice. The log file could be the source of both persistence AND notification (via `fs.watch`).

### 3.3 The eventSeq DB Update

Every event triggers `UPDATE sessions SET eventSeq = N`. This is the most expensive operation on the hot path — a write operation per event. Its only consumer is the SSE reconnect path, which reads the log file anyway. The eventSeq is used to determine "how many events exist" but the log file's line count provides the same information.

**Verdict**: eventSeq DB update could be debounced (every 5s or on status transitions) without data loss. Or eliminated if the SSE reconnect reads only from the log file.

### 3.4 The Adapter "Synthetic Event" Pattern

Codex and Gemini adapters emit "synthetic NDJSON" — they serialize their events to JSON strings, push them through `dataCallbacks`, which session-process.ts then re-parses as JSON and maps via `mapJsonToEvents`. This is a JSON→string→JSON round-trip:

```
Codex RPC notification → adapter creates JS object → JSON.stringify → dataCallback
→ session-process → SessionDataPipeline.processChunk → JSON.parse → mapJsonToEvents → emit
```

Compare with Claude SDK's direct path:

```
SDKMessage → mapSdkMessageToAgendoEvents → onEvents callback → processEvents → emit
```

The Claude SDK path skips the NDJSON round-trip entirely. **The Codex and Gemini adapters should follow this pattern.**

**Verdict**: The synthetic NDJSON pattern in Codex/Gemini/Copilot/OpenCode is an unnecessary serialization round-trip. These adapters should use the `onEvents` direct path like Claude SDK does.

---

## 4. Architectural Analysis: What Each Adapter ACTUALLY Does

### 4.1 Claude SDK Adapter (claude-sdk-adapter.ts, ~536 LOC)

**Integration model**: In-process Node.js library. No child process. SDK runs as part of the worker.

**What it does**:

- Creates a `query()` instance with an `AsyncQueue<SDKUserMessage>` for multi-turn
- Iterates the async generator, mapping each `SDKMessage` (22 message types) to `AgendoEventPayload[]`
- Uses `canUseTool` callback for approval bridging (supports `updatedInput` for editing tool calls, `updatedPermissions` for persistent rules, `interrupt` to stop the turn)
- Exposes 15+ control methods: `setPermissionMode`, `setModel`, `setMcpServers`, `reconnectMcpServer`, `toggleMcpServer`, `rewindFiles`, `mcpServerStatus`, `interrupt`, `supportedCommands`, `supportedModels`, `supportedAgents`, `accountInfo`, `initializationResult`, `stopTask`, `close`
- Token-level streaming via `stream_event` → `appendDelta`/`appendThinkingDelta` callbacks
- Supports programmatic subagents via `agents` option and `task_started`/`task_progress`/`task_notification` events
- In-process hooks system (21 hook events) for richer integration

**Adapter thickness**: THIN. The SDK provides typed objects; the adapter maps them 1:1. The mapper (`sdk-event-mapper.ts`, 281 LOC) is a clean type translation — no parsing, no buffering, no protocol management.

**What's unnecessary**: Nothing. This is the gold standard adapter pattern.

**Unused SDK capabilities with high potential**:

- `createSdkMcpServer()` — run Agendo MCP tools in-process (no stdio transport overhead)
- `getSessionMessages()` / `listSessions()` — session discovery and conversation replay without running process
- `outputFormat` — structured output for specific tasks (plan generation, code review reports)
- `maxBudgetUsd` / `maxTurns` — budget enforcement per session
- `promptSuggestions` — predicted next prompts for the UI
- `agentProgressSummaries` — AI-generated subagent progress summaries
- V2 Session API (`unstable_v2_createSession`) — cleaner than AsyncQueue pattern (when stable)

### 4.2 Codex App-Server Adapter (codex-app-server-adapter.ts, ~823 LOC)

**Integration model**: Spawns `codex app-server` as a child process. Communicates via NDJSON JSON-RPC over stdio.

**What it does**:

- Manages the full JSON-RPC lifecycle: `initialize` → `thread/start` → `turn/start` → notifications → `turn/completed`
- Handles server-initiated RPC requests (approval) with `handleServerRequest`
- Builds a `NdjsonRpcTransport` for reliable send/receive
- Emits "synthetic events" (`as:*` prefixed) via `dataCallbacks` string pipe
- Supports `steer`, `rollback`, `triggerCompaction`, `setModel`, MCP health checks
- Skills discovery via `skills/list` RPC + filesystem scanning

**Adapter thickness**: MEDIUM. The JSON-RPC transport layer is necessary infrastructure (Codex communicates via JSON-RPC, not a typed SDK). The synthetic event pattern adds ~100 LOC of unnecessary JSON round-tripping.

**What's unnecessary**: The synthetic NDJSON emission pattern. Events should flow directly as typed objects via `onEvents`, not through string serialization.

### 4.3 Gemini Adapter (gemini-adapter.ts, ~480 LOC)

**Integration model**: Spawns `gemini --experimental-acp` as a child process. Communicates via ACP (Agent Client Protocol) over stdio.

**What it does**:

- Uses `AcpTransport` (shared with Copilot) for ACP connection management
- `GeminiClientHandler` receives `sessionUpdate` callbacks and emits synthetic NDJSON
- `session/prompt` is synchronous (blocks until turn complete) — streaming via callbacks
- Model switching requires process restart (kill old, spawn new, `session/load`)
- TOML command scanning for slash command discovery

**Adapter thickness**: MEDIUM. ACP is a well-defined protocol; the adapter's job is to drive it. The model-switch-via-process-restart is complex but necessary (ACP limitation).

**What's unnecessary**: Same synthetic NDJSON pattern as Codex. Direct `onEvents` path would be cleaner.

### 4.4 Copilot Adapter (copilot-adapter.ts, ~350 LOC)

**Integration model**: Nearly identical to Gemini — spawns `copilot --acp`, uses shared `AcpTransport`.

**Adapter thickness**: THIN. Shares most infrastructure with Gemini via `AcpTransport` and `CopilotClientHandler`.

---

## 5. Recommended Architecture

### Option D: Lean Adapter + Log-First Events + Direct Object Path

This is the architecture that emerges from the analysis — not a full rewrite, but a set of targeted changes that eliminate the redundancies identified above while preserving everything that works.

#### Core Principles

1. **Log file is THE event store** — not PG NOTIFY, not the CLI's native storage
2. **Adapters emit typed objects, not strings** — all adapters use the `onEvents` direct path
3. **PG NOTIFY becomes a lightweight notification** — "new event available", not full payload carrier
4. **CLI native storage is supplementary** — used for resume/branching, not for replay
5. **The adapter layer is necessary but should be as thin as possible**

#### Architecture Diagram

```
Browser (EventSource)
    ↕ SSE (text/event-stream)
Next.js SSE Route
    ↑ fs.watch(logFile) OR pg_notify ping  ← NEW: notification-only
    │ Read new events from log file
    │
Worker (session-process.ts)
    │ emitEvent() → log file write + optional pg_notify ping
    │
SessionDataPipeline
    ↑ processEvents(AgendoEventPayload[])  ← ALL adapters use this path
    │
Adapter Layer (typed objects)
    ↑ mapXxxToAgendoEvents()
    │
CLI Protocol
    ↑ Claude SDK (in-process) / Codex JSON-RPC / ACP (Gemini/Copilot/OpenCode)
    │
Agent CLI Process
```

#### Change 1: All Adapters Use `onEvents` Direct Path

**Current**: Only Claude SDK uses `onEvents`. Codex/Gemini/Copilot/OpenCode emit synthetic NDJSON strings via `dataCallbacks` → `processChunk` → JSON.parse → `mapJsonToEvents`.

**Proposed**: All adapters emit typed `AgendoEventPayload[]` via `onEvents`. The `dataCallbacks`/`processChunk` NDJSON path is removed.

**Impact**:

- Eliminates JSON stringify→parse round-trip for 4 adapters
- Removes ~200 LOC (processChunk line buffering, JSON parsing, fallback text handling)
- All event processing goes through the clean `processEvents` path
- Stderr from child processes still goes through `dataCallbacks` for system:info
- Raw stdout logging (currently written by `processChunk`) moves to the adapter (adapter writes raw output to a debug log, not the event log)

**Files changed**:
| File | Change |
|---|---|
| `codex-app-server-adapter.ts` | Replace `emitSynthetic` → call event callbacks directly with typed payloads |
| `gemini-adapter.ts` | Replace `emitNdjson` → call event callbacks directly |
| `copilot-adapter.ts` | Replace `emitNdjson` → call event callbacks directly |
| `opencode-adapter.ts` | Replace `emitNdjson` → call event callbacks directly |
| `codex-app-server-event-mapper.ts` | Called in-adapter instead of via processChunk |
| `gemini-event-mapper.ts` | Called in-adapter instead of via processChunk |
| `copilot-event-mapper.ts` | Called in-adapter instead of via processChunk |
| `opencode-event-mapper.ts` | Called in-adapter instead of via processChunk |
| `session-data-pipeline.ts` | Remove `processChunk`, keep `processEvents` |
| `session-process.ts` | Remove `onData` wiring, all adapters use `onEvents` |
| `types.ts` (`ManagedProcess`) | `onEvents` becomes required; `onData` kept for stderr only |

**Effort**: ~1-2 days. Each adapter change is mechanical — replace string emission with typed emission.

#### Change 2: Debounce eventSeq DB Updates

**Current**: Every `emitEvent()` → `UPDATE sessions SET eventSeq = N` (1 write query per event)

**Proposed**: Debounce to every 5 seconds or on status transitions. The local `this.eventSeq` counter tracks the real value; the DB is eventually consistent.

**Impact**:

- Removes ~50% of DB write queries on the hot path
- SSE reconnect uses the log file for replay — slightly stale eventSeq means at most re-reading a few already-seen events (deduplicated by `lastEventId`)

**Files changed**: `session-process.ts` (add debounce timer in emitEvent, flush on transitionTo)

**Effort**: ~2 hours

#### Change 3: PG NOTIFY Payload Reduction (Quick Win)

**Current**: Full event JSON is sent via `SELECT pg_notify(channel, payload)`. 7500-byte limit triggers ref-stub workaround.

**Proposed**: Send only `{id: N}` as the pg_notify payload. The SSE route, upon receiving the notification, reads the new event(s) from the log file.

**Impact**:

- Eliminates the 7500-byte payload limit entirely
- Reduces NOTIFY payload to ~20 bytes (always fits, no ref-stub needed)
- SSE route changes from "parse payload → send" to "read log file from last offset → send"
- Delta events (text-delta, thinking-delta) need special handling — either:
  (a) Write them to the log (adds file writes but unifies the path), or
  (b) Keep them as full-payload NOTIFY (they're small, <100 bytes), or
  (c) Drop deltas entirely (complete text events follow anyway)

**Recommended**: Option (b) — keep deltas as full-payload NOTIFY since they're small and ephemeral. All other events use the ping pattern.

**Files changed**: `session-process.ts` (emitEvent publishes `{id}` instead of full event), `events/route.ts` (on notification, read from log), `pg-notify.ts` (no functional change)

**Effort**: ~4 hours

#### Change 4: Single-Connection Notifier Pattern (Quick Win)

**Current**: One PG connection per active channel (up to 20).

**Proposed**: One PG connection total, LISTEN on all active channels simultaneously.

**Impact**: Reduces listener pool from max=20 to max=1. Already validated by Brandur Notifier Pattern.

**Files changed**: `pg-notify.ts` (~50 LOC refactor)

**Effort**: ~2 hours

#### Change 5 (Future): Replace PG NOTIFY with fs.watch + Worker HTTP

This is the bigger migration from the pg-notify ADR. Only pursue if Changes 2-4 prove insufficient.

**Events direction**: Worker writes to log file → `fs.watch` in SSE route → push to browser
**Control direction**: API routes → HTTP POST to worker HTTP endpoint → dispatch to session

**Impact**: Eliminates ALL PG connections for IPC. But touches 20+ files, requires rethinking brainstorm cross-channel, and adds a worker HTTP server.

**Decision**: Defer. Changes 2-4 address the immediate pain points with minimal risk.

---

## 6. What NOT To Change

### 6.1 The Adapter Layer is Necessary

The user's question implied the adapter layer might be redundant because "CLIs have TUIs that show everything." This analysis confirms the adapter layer is NOT redundant:

1. **No CLI provides a browser-accessible transport** — a server-side mediator is mandatory
2. **~50% of AgendoEvent types are Agendo-generated** — no CLI equivalent exists
3. **The CLIs have incompatible formats** — normalization is required
4. **The CLIs' native event streams are only available while the process runs** — persistence requires our own log

### 6.2 The Log File is the Right Source of Truth

The log file serves as:

- The SSE replay source (browser reconnect)
- The audit trail
- The single source of truth for ALL agent types
- The persistence layer (PG NOTIFY is ephemeral)

No CLI's native storage can replace it because Agendo adds ~15 event types that don't exist in any CLI.

### 6.3 PG NOTIFY for Control Direction

The control channel (Frontend → Worker) is low-frequency (user messages, tool approvals, model changes). PG NOTIFY works well here — broadcast semantics, no routing needed, no HTTP server required. Replacing it would add complexity (worker HTTP server, service discovery) for negligible benefit.

---

## 7. Recommended Implementation Order

| Priority | Change                                     | Effort   | Impact                                    | Risk         |
| -------- | ------------------------------------------ | -------- | ----------------------------------------- | ------------ |
| 1        | **Debounce eventSeq** (Change 2)           | 2 hours  | ~50% fewer DB writes                      | Very low     |
| 2        | **Single-connection Notifier** (Change 4)  | 2 hours  | 20→1 PG listener connections              | Low          |
| 3        | **All adapters use onEvents** (Change 1)   | 1-2 days | Cleaner architecture, no JSON round-trips | Medium       |
| 4        | **PG NOTIFY payload reduction** (Change 3) | 4 hours  | No payload limit, reduced NOTIFY size     | Medium       |
| 5        | **fs.watch + Worker HTTP** (Change 5)      | 3-4 days | Zero PG connections for IPC               | High — defer |

Changes 1-4 can be done in any order. Each is independently valuable. Together they address every identified redundancy without a full architecture migration.

---

## 8. Per-CLI Answers to the Core Questions

### Can we read full conversation history from the CLI's native storage?

| CLI     | Answer    | Detail                                                                                                                                                                                        |
| ------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude  | Partially | `getSessionMessages()` returns raw API messages (parses JSONL on disk, no running process needed). But loses ~15 Agendo-generated event types. `listSessions()` also available for discovery. |
| Codex   | Partially | `thread/read` with `includeTurns: true` returns full conversation history including ThreadItem details. But requires running app-server process.                                              |
| Gemini  | Barely    | `session/load` replays as notifications, not structured history. Requires running process.                                                                                                    |
| Copilot | No        | No history API. Internal session storage only.                                                                                                                                                |

**Verdict**: Cannot replace Agendo's log file with CLI native storage.

### Can we get real-time events from the CLI's protocol?

| CLI     | Answer          | Detail                                                                                            |
| ------- | --------------- | ------------------------------------------------------------------------------------------------- |
| Claude  | Yes, richly     | SDK `query()` async generator provides typed `SDKMessage` objects with cost, timing, token usage. |
| Codex   | Yes, moderately | JSON-RPC notifications provide text deltas, tool events, turn lifecycle. No cost/token data.      |
| Gemini  | Yes, basic      | ACP `sessionUpdate` provides text, tool calls. No cost/token/thinking data.                       |
| Copilot | Yes, basic      | Same as Gemini (shared ACP protocol).                                                             |

**Verdict**: Real-time events are available from all CLIs. The adapter maps them to `AgendoEventPayload`. This mapping is the irreducible minimum.

### What Agendo-specific events MUST we add?

11 mandatory capabilities (Section 2.1) + 6 valuable enrichments (Section 2.2). These represent ~50% of the event taxonomy and are Agendo's core value-add.

### What's the MINIMAL adapter layer needed?

For each CLI:

- **Claude**: `sdk-event-mapper.ts` (281 LOC) — type translation only. Already minimal.
- **Codex**: `codex-app-server-event-mapper.ts` (399 LOC) + JSON-RPC transport (~200 LOC). Transport is necessary; mapper could be slightly slimmed.
- **Gemini**: `gemini-event-mapper.ts` (183 LOC) + ACP transport (~300 LOC) + client handler (~200 LOC). Transport/handler necessary; mapper is already thin.
- **Copilot**: Same as Gemini, with Copilot-specific client handler.

Total adapter code: ~2500 LOC across all adapters. This is already reasonably lean for managing 4 different CLI protocols.

### Can we forward CLI events more directly to the browser?

**Yes — by eliminating the NDJSON string round-trip (Change 1)**. Currently, Codex/Gemini/Copilot serialize events to JSON strings, push through `dataCallbacks`, which are re-parsed by `processChunk`. The Claude SDK already skips this with `onEvents`. All adapters should follow that pattern.

Beyond that, the CLI events cannot be forwarded directly because:

1. The browser expects `AgendoEventPayload` format (not CLI-native formats)
2. Agendo adds state machine, approval bridge, team, and other events inline
3. The SSE protocol wraps events in `id: N\ndata: {...}\n\n` framing

---

## 9. Summary

The current architecture is **fundamentally correct** in its layering. The adapter + event normalization + log file + SSE pipeline is the right design for a multi-CLI management platform. The redundancies are in implementation details, not architecture:

1. **The NDJSON string round-trip** in 4 of 5 adapters — should use direct typed object path
2. **The per-event eventSeq DB write** — should be debounced
3. **The full-payload PG NOTIFY** — should be a lightweight ping
4. **The per-channel PG connection** — should be a single connection

These are all changes that preserve the architecture while reducing overhead. The estimated total effort for Changes 1-4 is 2-3 days, touching ~15 files with well-scoped, independently testable changes.

**The right architecture is NOT "eliminate layers" but "make each layer do exactly what it needs to and nothing more."**

---

## Appendix A: Event Type Taxonomy (29 types)

### CLI-Derived (normalized from CLI output) — 14 types

- `agent:text`, `agent:text-delta`, `agent:thinking`, `agent:thinking-delta`
- `agent:tool-start`, `agent:tool-end`, `agent:result`, `agent:ask-user`
- `session:init`, `session:commands`, `session:mode-change`
- `system:error`, `system:rate-limit`, `agent:plan`

### Agendo-Original (no CLI equivalent) — 15 types

- `agent:activity`, `agent:tool-approval`, `agent:usage`
- `session:state`, `user:message`
- `system:info`, `system:compact-start`, `system:mcp-status`
- `team:message`, `team:config`, `team:task-update`, `team:outbox-message`
- `subagent:start`, `subagent:progress`, `subagent:complete`

### Ratio: 48% CLI-derived, 52% Agendo-original

This confirms the adapter layer's role: it normalizes the ~48% of events that come from CLIs, and the session process adds the ~52% that are Agendo's unique value.

---

## Appendix B: Files Affected by All Recommended Changes

| File                          | Change 1            | Change 2       | Change 3      | Change 4    |
| ----------------------------- | ------------------- | -------------- | ------------- | ----------- |
| `session-process.ts`          | Remove onData       | Debounce timer | Ping publish  | —           |
| `session-data-pipeline.ts`    | Remove processChunk | —              | —             | —           |
| `codex-app-server-adapter.ts` | Direct onEvents     | —              | —             | —           |
| `gemini-adapter.ts`           | Direct onEvents     | —              | —             | —           |
| `copilot-adapter.ts`          | Direct onEvents     | —              | —             | —           |
| `opencode-adapter.ts`         | Direct onEvents     | —              | —             | —           |
| `types.ts`                    | onEvents required   | —              | —             | —           |
| `pg-notify.ts`                | —                   | —              | —             | Single conn |
| `events/route.ts`             | —                   | —              | Read from log | —           |

---

## Appendix C: Opportunities From Protocol Expert Analyses

### Claude SDK (from claude-sdk-deep-analysis.md)

| Opportunity                                                  | Value                                                                                                              | Effort                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **`createSdkMcpServer()`** — in-process MCP tools            | Eliminates stdio transport + MCP server process. Tools run as direct function calls.                               | Medium — need to port MCP tool handlers from `src/lib/mcp/server.ts` to SDK tool format |
| **`getSessionMessages()` + `listSessions()`** — session sync | Detect sessions started outside Agendo, import conversation history, richer replay                                 | Low — read-only APIs, can supplement Agendo's log                                       |
| **`outputFormat` (JSON schema)** — structured output         | Force structured responses for plan generation, code review reports, task summaries                                | Low — pass-through option                                                               |
| **`maxBudgetUsd`** — budget enforcement                      | Per-session/task budget caps with automatic `error_max_budget_usd` stop                                            | Low — pass-through option                                                               |
| **`promptSuggestions`** — predicted next prompts             | Show "suggested next messages" in chat UI                                                                          | Low — new SDKMessage type to handle                                                     |
| **`agentProgressSummaries`** — subagent progress             | AI-generated progress summaries in Team Panel instead of raw tool names                                            | Low — pass-through option                                                               |
| **In-process hooks** — 21 event types                        | PostToolUse for automatic progress, PermissionRequest for centralized policy, SubagentStart/Stop for team tracking | Medium — design hook handlers                                                           |
| **V2 Session API** — cleaner multi-turn                      | `SDKSession.send()` + `stream()` replaces AsyncQueue pattern                                                       | Wait — still `@alpha`                                                                   |

### Codex App-Server (from codex-protocol-deep-analysis.md)

| Opportunity                                                      | Value                                                                            | Effort                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **`thread/read` with `includeTurns`** — full history             | Reconstruct conversation without maintaining separate log for Codex sessions     | Low — single RPC call                                             |
| **`modelContextWindow`** — real context size                     | Replace hardcoded 200K with actual model context window from token usage updates | Trivial — extract field from existing notification                |
| **`persistExtendedHistory`** — richer replay                     | Get detailed item history for session reconstruction                             | Low — flag in thread/start                                        |
| **Dynamic tool calls (`item/tool/call`)** — client-defined tools | Register Agendo-specific tools directly in Codex (alternative to MCP)            | Medium — define tool schemas, handle results                      |
| **`thread/fork` + `thread/rollback`** — conversation branching   | Expose in UI for "what if" exploration                                           | Medium — UI + adapter support (adapter already supports rollback) |

### Gemini/Copilot ACP (from gemini-acp-deep-analysis.md)

| Opportunity                                           | Value                                                                            | Effort                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- |
| **`session/load`** — full history replay              | Reconstruct conversation after process restart (currently used for model switch) | Already implemented                            |
| **`session/resume`** — faster reconnect               | Skip replay overhead when resuming interrupted sessions                          | Low — add resume path alongside load           |
| **`session/fork`** — conversation branching           | Fork Gemini sessions for exploration (Gemini-only, not available in Copilot)     | Medium — UI + adapter                          |
| **Cost field in `UsageUpdate`** — cost tracking       | Extract cost data (currently not parsed from Gemini/Copilot)                     | Low — parse existing field                     |
| **Diff content type** — file diff rendering           | Render structured diffs in UI (currently treated as plain text)                  | Medium — UI renderer                           |
| **Terminal protocol** — integrated terminal           | ACP defines terminal protocol but it's not implemented in Gemini/Copilot         | Defer — not yet available upstream             |
| **`unstable_setSessionModel`** — Copilot model switch | In-place model switching for Copilot (avoid process restart)                     | Low — already known, Copilot-specific ACP call |

---

_Document complete. Incorporates findings from all three protocol expert analyses: claude-sdk-deep-analysis.md, codex-protocol-deep-analysis.md, gemini-acp-deep-analysis.md._
