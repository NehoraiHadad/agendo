# Research: Can Agendo Delegate Session Management to CLI-Native Mechanisms?

**Date**: 2026-03-16
**Status**: Research complete
**Question**: Is Agendo's event/streaming/log layer redundant given that each CLI tool has native session persistence?

---

## Table of Contents

1. [CLI-by-CLI Analysis of Native Session Capabilities](#1-cli-by-cli-analysis)
2. [What Agendo's Layer Adds vs What's Redundant](#2-agendo-layer-analysis)
3. [Architecture Options](#3-architecture-options)
4. [Feasibility Assessment](#4-feasibility-assessment)
5. [Recommendation](#5-recommendation)

---

## 1. CLI-by-CLI Analysis

### 1.1 Claude Code — Native Session Mechanism

**Storage location**: `~/.claude/projects/{project-path-slug}/{sessionId}.jsonl`

Each session has:

- A JSONL transcript file (the full conversation)
- A companion directory `{sessionId}/` containing `subagents/` and `tool-results/`
- An entry in `~/.claude/history.jsonl` (global history index)

**JSONL transcript record types** (verified by examining real files):

| Record Type             | Fields                                                                                 | Contains                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `user`                  | message, uuid, parentUuid, sessionId, cwd, gitBranch, permissionMode, timestamp, todos | Full user message with role/content                      |
| `assistant`             | message, uuid, parentUuid, sessionId, requestId, timestamp                             | Full assistant message (text, tool_use, thinking blocks) |
| `progress`              | data, toolUseID, parentToolUseID, parentUuid, uuid                                     | Tool execution progress/results                          |
| `system`                | subtype, slug, stopReason, hookCount, hookErrors, level                                | System events (init, compact_boundary, hooks)            |
| `queue-operation`       | operation, content, sessionId                                                          | Internal queue ops (written before agent starts)         |
| `file-history-snapshot` | messageId, snapshot                                                                    | File state checkpoints for rewind                        |

**Key insight**: The JSONL contains the _raw API-level conversation_ (MessageParam objects with content blocks), NOT the event-level stream that Agendo needs. There are no tool-start/tool-end timing events, no cost breakdowns per turn, no session state transitions, no token usage deltas, no real-time streaming deltas.

**SDK APIs for reading history** (from `@anthropic-ai/claude-agent-sdk` v2.1.x):

```typescript
// List all sessions for a project
listSessions({ dir?: string, limit?: number }): Promise<SDKSessionInfo[]>
// SDKSessionInfo = { sessionId, summary, lastModified, fileSize, customTitle?, firstPrompt?, gitBranch?, cwd? }

// Read messages from a session transcript
getSessionMessages(sessionId: string, { dir?, limit?, offset? }): Promise<SessionMessage[]>
// SessionMessage = { type: 'user'|'assistant', uuid, session_id, message: unknown, parent_tool_use_id: null }
```

**Resume mechanism**:

- `--resume {sessionId}` loads the JSONL and reconstructs the conversation context (API messages) for the LLM
- `--resume-session-at {uuid}` branches from a specific message in the conversation tree (the JSONL uses parentUuid chains, enabling tree-structured conversations with sidechains)
- `--fork-session` creates a new session starting from the parent's state
- The SDK `query()` function accepts `resume` and `resumeSessionAt` in its options

**What Claude natively persists**:

- Full conversation messages (user prompts, assistant responses with all content blocks)
- Tool use inputs and results
- File change checkpoints (for rewind)
- System events (init, compact boundaries)
- Sidechain/branch structure via parentUuid

**What Claude does NOT persist natively**:

- Real-time streaming deltas (token-by-token text)
- Tool execution timing (durationMs)
- Per-turn cost breakdowns (costUsd, modelUsage with cache stats)
- Session state machine transitions (active/awaiting_input/idle/ended)
- Context window usage metrics (used/size)
- Rate limit events
- MCP server connection status
- Service tier / inference geo
- Permission denial tracking
- Web search/fetch usage counts

**SDK interaction model**: The SDK's `Query` interface is an `AsyncGenerator<SDKMessage, void>`. Agendo iterates it and maps each `SDKMessage` to `AgendoEventPayload[]` via `sdk-event-mapper.ts`. The SDK provides typed objects (not raw NDJSON), but these are _live stream events_, not a post-hoc history API. There is no way to "subscribe to an existing running session" -- you must be the process that called `query()`.

### 1.2 Codex CLI — Native Thread Mechanism (app-server)

**Storage location**: `~/.codex/sessions/{year}/{month}/{day}/rollout-{timestamp}-{threadId}.jsonl`

These are JSONL rollout files -- they record the thread's conversation for the TUI's history display. The `app-server` protocol also stores thread state in memory.

**Thread management via JSON-RPC** (from `codex app-server`):

| Method                 | Direction     | Purpose                                 |
| ---------------------- | ------------- | --------------------------------------- |
| `thread/start`         | client→server | Create new thread, get threadId + model |
| `thread/resume`        | client→server | Resume existing thread (by threadId)    |
| `thread/fork`          | client→server | Fork a thread (copy history, new ID)    |
| `thread/rollback`      | client→server | Undo last N turns                       |
| `thread/compact/start` | client→server | Trigger context compaction              |
| `turn/start`           | client→server | Send a message, start a new turn        |
| `turn/interrupt`       | client→server | Cancel current turn mid-flight          |
| `turn/steer`           | client→server | Inject mid-turn guidance                |

**Notifications (server→client, real-time stream)**:

| Notification                            | Content                                                  |
| --------------------------------------- | -------------------------------------------------------- |
| `turn/started`                          | Turn began, turnId                                       |
| `turn/completed`                        | Turn finished, status, error                             |
| `item/started`                          | Thread item began (agentMessage, commandExecution, etc.) |
| `item/completed`                        | Thread item finished with full content                   |
| `item/agentMessage/delta`               | Token-level text streaming                               |
| `item/reasoning/summaryTextDelta`       | Thinking/reasoning deltas                                |
| `item/commandExecution/outputDelta`     | Shell command output streaming                           |
| `item/plan/delta`                       | Plan text streaming                                      |
| `thread/tokenUsage/updated`             | Token usage counters                                     |
| `item/commandExecution/requestApproval` | Permission request (server→client RPC)                   |
| `item/fileChange/requestApproval`       | File change approval request                             |

**Key insight**: Codex app-server provides rich real-time events, but they are _ephemeral notifications over a live stdio connection_. There is no `thread/getHistory` or `thread/listItems` method. Once the `app-server` process exits, the only record is the rollout JSONL file on disk, which has a different format than the RPC notifications.

**What Codex natively persists**:

- Rollout JSONL files with conversation history
- Thread/turn structure
- Thread can be resumed by ID

**What Codex does NOT provide**:

- An API to read a thread's history programmatically from a running app-server
- Session state machine (active/awaiting/idle/ended -- this is Agendo's concept)
- Cost tracking (no cost data in the protocol)
- MCP server health monitoring
- Cross-agent team coordination
- Browser-accessible streaming (the protocol is stdio-based)

### 1.3 Gemini CLI — Native Session via ACP

**Storage location**: `~/.gemini/tmp/{project-hash}/{sessionId}/plans/` (plan mode only). Session conversation history is managed internally by the Gemini process.

**ACP session management** (from `@agentclientprotocol/sdk`):

| Method                      | Purpose                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `session/new`               | Create new session, get sessionId                              |
| `session/load`              | Load existing session (replays full history via notifications) |
| `session/resume` (unstable) | Resume without replaying history                               |
| `session/list` (unstable)   | List existing sessions                                         |
| `session/fork`              | Fork a session                                                 |
| `session/prompt`            | Send a message (blocking, returns when turn complete)          |
| `session/cancel`            | Cancel current turn                                            |
| `session/setMode`           | Change permission mode                                         |

**Key architectural difference**: ACP's `session/prompt` is a _synchronous RPC_ -- the client sends a prompt and blocks until the agent's full response is ready. Real-time streaming happens via the `Client.sessionUpdate()` callback, which receives partial content as notifications during the prompt call.

**session/load** is the closest to "read history" -- but it _replays_ the conversation as a series of sessionUpdate notifications. It does not return a structured history object. This replay is designed for the ACP client to reconstruct its internal state, not for a UI to display.

**What Gemini natively persists**:

- Sessions can be loaded/resumed by ID
- Plan files in `~/.gemini/tmp/{project}/{sessionId}/plans/`
- History replay via session/load

**What Gemini does NOT provide**:

- A structured history read API
- Cost/token metrics (not exposed via ACP)
- Thinking/reasoning content (Gemini does not expose chain-of-thought)
- Session state machine
- MCP health status

### 1.4 GitHub Copilot CLI — Native Session via ACP

Copilot uses the same ACP protocol as Gemini. Its session capabilities are identical in terms of the protocol layer. Copilot supports `--resume={sessionId}` for session persistence.

**Storage**: Managed internally by the Copilot process. No known on-disk session files beyond what the ACP client stores.

---

## 2. What Agendo's Layer Adds vs What's Redundant

### 2.1 AgendoEvent Type Classification

Every `AgendoEvent` type, classified by origin:

| Event Type             | Source            | CLI-Native? | Agendo-Only? | Notes                                                                                                              |
| ---------------------- | ----------------- | ----------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `agent:text`           | All CLIs          | Partially   | No           | CLIs produce text, but Agendo normalizes format                                                                    |
| `agent:text-delta`     | Claude, Codex     | Partially   | No           | Token streaming -- CLIs produce this, Agendo relays                                                                |
| `agent:thinking`       | Claude            | Yes         | No           | Thinking blocks from Claude's JSONL                                                                                |
| `agent:thinking-delta` | Claude            | Yes         | No           | Streamed thinking tokens                                                                                           |
| `agent:tool-start`     | All CLIs          | Yes         | No           | Tool invocations -- CLIs emit these                                                                                |
| `agent:tool-end`       | All CLIs          | Yes         | No           | Tool results -- CLIs emit these                                                                                    |
| `agent:result`         | All CLIs          | Partially   | Partially    | CLIs provide base data; Agendo enriches with cost, per-call stats, permission denials, web tool usage, messageUuid |
| `agent:activity`       | Agendo            | No          | **Yes**      | Thinking state tracking -- Agendo synthesizes from adapter signals                                                 |
| `agent:tool-approval`  | Agendo            | No          | **Yes**      | Permission UI -- Agendo intercepts CLI approval requests and bridges to browser                                    |
| `agent:plan`           | Agendo            | No          | **Yes**      | Plan entries extracted from agent output                                                                           |
| `agent:usage`          | Agendo            | No          | **Yes**      | Real-time context window meter -- calculated from message_start stats                                              |
| `agent:ask-user`       | Claude            | Partially   | Partially    | Claude's AskUserQuestion -- Agendo bridges to interactive UI                                                       |
| `session:init`         | All CLIs          | Partially   | Partially    | Aggregates sessionRef, slashCommands, mcpServers, model, tools, permissionMode                                     |
| `session:commands`     | All CLIs          | Partially   | No           | Slash commands/skills -- discovered from CLIs + filesystem scan                                                    |
| `session:state`        | Agendo            | No          | **Yes**      | State machine (active/awaiting_input/idle/ended)                                                                   |
| `session:mode-change`  | Agendo            | No          | **Yes**      | Permission mode change tracking                                                                                    |
| `user:message`         | Agendo            | No          | **Yes**      | User messages recorded in Agendo's log (CLIs store them in their own format)                                       |
| `system:info`          | Agendo            | No          | **Yes**      | Compaction notices, MCP warnings, model rerouting                                                                  |
| `system:compact-start` | Agendo            | No          | **Yes**      | Context compaction tracking                                                                                        |
| `system:error`         | All CLIs + Agendo | Partially   | Partially    | Error forwarding + Agendo-generated errors                                                                         |
| `system:mcp-status`    | Agendo            | No          | **Yes**      | MCP server health monitoring                                                                                       |
| `system:rate-limit`    | Claude            | Yes         | No           | Rate limit events from Claude SDK                                                                                  |
| `team:message`         | Agendo            | No          | **Yes**      | Multi-agent team coordination                                                                                      |
| `team:config`          | Agendo            | No          | **Yes**      | Team membership tracking                                                                                           |
| `team:task-update`     | Agendo            | No          | **Yes**      | Team task list updates                                                                                             |
| `team:outbox-message`  | Agendo            | No          | **Yes**      | Lead-to-teammate messages                                                                                          |
| `subagent:start`       | Agendo            | No          | **Yes**      | Subagent spawn tracking                                                                                            |
| `subagent:progress`    | Agendo            | No          | **Yes**      | Subagent transcript tailing                                                                                        |
| `subagent:complete`    | Agendo            | No          | **Yes**      | Subagent completion                                                                                                |

### 2.2 Summary: What Would Be Lost

**Events that are purely Agendo-generated (no CLI equivalent):**

1. **Session state machine** (`session:state`) -- active/awaiting_input/idle/ended. This is the core of Agendo's session lifecycle management. No CLI provides this.

2. **Tool approval UI bridge** (`agent:tool-approval`) -- The CLIs have their own approval mechanisms (Claude's `canUseTool`, Codex's `requestApproval` RPC, Gemini's `requestPermission` ACP callback). Agendo intercepts these and bridges them to a browser-based approval UI. Without Agendo's layer, there is no way for a remote browser user to approve tools.

3. **Team coordination** (`team:*`) -- Agendo manages multi-agent teams via Claude's TeamCreate tool, file-based inbox monitoring, and cross-agent message routing. This is entirely Agendo-specific.

4. **Subagent tracking** (`subagent:*`) -- Agendo tails JSONL files written by Claude's subagent tool to provide real-time progress on nested agent calls.

5. **Context window metrics** (`agent:usage`) -- Real-time context utilization calculated from per-call message_start stats. No CLI exposes this in a consumable format.

6. **MCP server health** (`system:mcp-status`) -- Periodic health checks that detect disconnected MCP servers. Agendo-initiated.

7. **User messages in the event stream** (`user:message`) -- The CLIs store user messages in their own transcript formats. Agendo re-emits them as events so the SSE log is a complete, self-contained record of the conversation.

**Events that are partially CLI-native but enriched by Agendo:**

1. **agent:result** -- Claude provides cost, turns, duration, modelUsage, errors. Agendo adds: perCallContextStats, messageUuid (for branching), permission denials, web tool usage counters, service tier, inference geo. Codex and Gemini provide _no_ cost data.

2. **session:init** -- Agendo aggregates data from different sources per-CLI into a unified init event.

### 2.3 What IS Redundant

The core conversation content (agent text, tool calls, tool results) is duplicated between Agendo's log and the CLI's native storage. Specifically:

- **agent:text** -- Claude's JSONL stores the full text. Codex emits `item/completed` with text. Gemini returns text in the prompt response.
- **agent:tool-start/tool-end** -- All CLIs track tool invocations natively.
- **agent:thinking** -- Claude's JSONL stores thinking blocks.

However, this "redundancy" exists because:

1. The CLI-native formats are all different (JSONL tree-structure for Claude, JSON-RPC notifications for Codex, ACP sessionUpdate for Gemini)
2. The CLI-native data is not directly browser-accessible
3. The CLI's native event stream is only available while the process is running

---

## 3. Architecture Options

### Option A: Full CLI-Native (Eliminate Agendo's Layer)

**Concept**: Browser connects "directly" to the CLI session. Agendo acts as a thin proxy.

**For Claude**: Use `getSessionMessages()` SDK API to read history. Use `query()` with streaming for live output. Forward SDKMessages to browser via WebSocket/SSE.

**For Codex**: Connect to `codex app-server` via JSON-RPC. Forward notifications to browser.

**For Gemini/Copilot**: Use ACP `session/load` to replay history. Forward `sessionUpdate` notifications to browser.

**What breaks immediately**:

- **No unified event format** -- Browser would need three different parsers
- **No tool approval bridging** -- Each CLI's approval mechanism works differently; the browser can't respond to Claude's `canUseTool` callback, Codex's JSON-RPC server request, or Gemini's ACP `requestPermission`
- **No session state machine** -- Browser has no way to know when the agent is "awaiting input" vs "active"
- **No team coordination** -- Team features are entirely Agendo-generated
- **No idle timeout / heartbeat** -- CLIs don't self-terminate on idle; Agendo manages this
- **No pg-boss job queue** -- Session scheduling, concurrency limits, auto-resume all depend on Agendo's queue
- **No cross-session MCP injection** -- Agendo injects the MCP server config dynamically
- **No history after process exits** -- Codex and Gemini only provide live streaming; once the process dies, you can't read history. Claude's `getSessionMessages()` helps, but returns raw API messages (not the enriched event format the UI expects)
- **No cost tracking** for Codex and Gemini

**Verdict**: Not viable. The CLIs were designed as single-user local tools. They have no concept of remote browser clients, persistent session state machines, multi-agent orchestration, or centralized job scheduling.

### Option B: Hybrid (Use CLI-Native for History, Agendo for Live)

**Concept**: For session replay (page refresh, SSE reconnect), read history from CLI native storage instead of Agendo's log file. For live streaming, keep Agendo's adapter layer.

**For Claude**: Replace log file replay with `getSessionMessages()` calls, mapping `SessionMessage[]` to `AgendoEvent[]`.

**For Codex**: On `thread/resume`, Codex doesn't replay history (unlike `session/load` for Gemini). Would still need Agendo's log.

**For Gemini**: On `session/load`, Gemini replays full history via sessionUpdate notifications. Could potentially capture this replay and convert to AgendoEvents.

**What breaks**:

- **Claude's `getSessionMessages()` returns raw API messages**, not enriched AgendoEvents. You lose: tool timing, cost per turn, context window stats, MCP status, team events, subagent progress, user messages (they're in the JSONL but `SessionMessage` is user|assistant only), permission denials, session state transitions.
- **Codex has no history API** -- `thread/resume` just resumes; it doesn't replay.
- **Gemini's session/load replay** produces `sessionUpdate` notifications -- these map to text/tool events but not to the enriched AgendoEvent format. Plus, you'd need to re-parse them into AgendoEvents, which is essentially what the adapter already does.
- **The Agendo log format is purpose-built** for the SSE replay use case. It contains every event in order, pre-serialized. Reconstructing this from CLI native storage would be lossy and complex.

**Potential benefit**: If Claude's JSONL were used as the source of truth, you'd get conversation branching (parentUuid tree) "for free" -- something Agendo's linear log doesn't support.

**Verdict**: Marginal benefit, significant complexity. The only real win would be conversation branching, which could be added to Agendo's log format more simply.

### Option C: Current Architecture (Agendo's Full Layer)

```
Agent CLI/SDK → Adapter normalizes → AgendoEvent → pg_notify → SSE → Browser
                                   → Log file (for replay)
```

**What this provides**:

1. **Unified event format** across all 4 CLIs
2. **Complete history** in a single log file, including Agendo-specific events
3. **SSE replay** with sequence-number-based deduplication
4. **Bidirectional control** (messages, approvals, model changes, MCP management)
5. **Session lifecycle** (state machine, idle timeout, heartbeat, auto-resume)
6. **Team coordination** (multi-agent inbox monitoring)
7. **Job scheduling** (pg-boss queue, concurrency limits)
8. **Cost tracking** (persisted to DB, includes per-call stats)

**Trade-off**: Agendo's log duplicates conversation content that the CLIs also store.

---

## 4. Feasibility Assessment

### 4.1 Can the Browser Connect Directly to a CLI Session?

**No.** All four CLIs communicate over local stdio (stdin/stdout of a child process). There is no network transport:

- Claude SDK runs in-process as a Node.js library
- Codex app-server communicates via NDJSON over stdio
- Gemini/Copilot communicate via ACP NDJSON over stdio

A server-side mediator is always required. The browser cannot bypass the server.

### 4.2 Can We Read CLI History Without Our Adapter Layer?

**Claude**: Yes, partially. `getSessionMessages()` returns `SessionMessage[]` (user + assistant messages). But these are raw API messages, not the enriched event stream. You'd lose ~15 event types.

**Codex**: No. There is no API to read thread history from a running app-server. The rollout JSONL on disk has a different format than the event stream.

**Gemini/Copilot**: Only via `session/load`, which requires a running process and replays as notifications. Not a read-only history API.

### 4.3 Could We Use CLI-Native Resume and Skip Our Own Log?

The CLIs already handle resume:

- Claude: `--resume {sessionId}` or SDK `resume` option
- Codex: `thread/resume` RPC
- Gemini: `session/load` or `session/resume` ACP

Agendo already uses these for warm/cold resume. The question is whether Agendo's log file could be eliminated.

**Answer**: No. The log file serves two purposes the CLIs don't cover:

1. **SSE catchup on page refresh** -- When a browser reconnects, the SSE endpoint reads the log file and replays events after `lastEventId`. Without the log, the browser would see nothing until the next agent event.
2. **Agendo-specific events** -- team messages, subagent progress, user messages, session state transitions, MCP status -- these are NOT in any CLI's native storage.

### 4.4 What About Claude's SDK-Level Session Model?

The Claude SDK's `getSessionMessages()` and `listSessions()` APIs are the most promising integration point. They could be used to:

- Build a "session browser" that shows Claude sessions not managed by Agendo
- Cross-reference Agendo's session with Claude's JSONL for debugging
- Implement conversation branching by reading the parentUuid tree

But they cannot replace Agendo's event stream because they return a different data model (API messages vs enriched events).

---

## 5. Recommendation

### The Agendo Event/Streaming/Log Layer is NOT Redundant

The layer is necessary for these reasons:

1. **No CLI provides a browser-accessible event stream.** All CLIs communicate over local stdio. A server-side mediator that converts CLI output to SSE is architecturally mandatory.

2. **The CLIs have incompatible session formats.** Claude uses JSONL with parentUuid trees. Codex uses JSON-RPC notifications. Gemini uses ACP sessionUpdate callbacks. The adapter layer that normalizes these into `AgendoEventPayload` is the minimum viable bridge.

3. **~50% of AgendoEvent types are Agendo-generated** and have no CLI equivalent: session state machine, tool approval UI bridge, team coordination, subagent tracking, MCP health, context metrics, user message recording.

4. **CLI history APIs are insufficient for replay.** Only Claude has a structured history read API (`getSessionMessages`), and it returns raw API messages without the enrichment Agendo adds (timing, cost, context stats, etc.). Codex and Gemini have no read-only history API at all.

5. **The log file is the single source of truth for SSE replay.** On browser reconnect, the SSE endpoint reads Agendo's log file to catch up. This is fast, sequential, and format-consistent. Reconstructing the same data from CLI native storage would be lossy and require per-CLI logic.

### What COULD Be Simplified

While the full layer is necessary, there are opportunities to reduce redundancy:

1. **Stop duplicating raw stdout in the log file.** Currently, `session-process.ts` writes both raw stdout lines and structured events. For SDK adapters (Claude), the raw stdout is already gone. For CLI adapters (Codex, Gemini), the raw NDJSON could be dropped from the log -- only the structured AgendoEvents need to be persisted.

2. **Use Claude's SDK APIs for supplementary features.** `listSessions()` and `getSessionMessages()` could power a "Claude session explorer" or enable conversation branching features without replacing the core event stream.

3. **Lean into the SDK adapter path.** The Claude SDK adapter (`claude-sdk-adapter.ts`) already bypasses NDJSON parsing entirely -- it receives typed `SDKMessage` objects and maps them directly to `AgendoEventPayload[]`. This is the cleanest integration pattern. If Codex and Gemini ever offer SDK-level APIs (not just stdio protocols), the same pattern should be adopted.

4. **Consider persisting Claude's sessionRef→JSONL mapping.** Agendo already stores `sessionRef` in the sessions table. Adding a column for the JSONL path would enable reading Claude's native transcript when needed (e.g., for branching, or for a "raw transcript" view).

### Bottom Line

The question "Can we just connect to the CLI's native session?" assumes the CLIs provide a remotely-accessible, unified, enriched event stream with bidirectional control. They do not. Each CLI is designed as a local, single-user tool with its own storage format, its own streaming mechanism, and its own approval flow. Agendo's adapter layer is the glue that unifies these four different tools into a coherent multi-agent management platform. It is not redundant -- it is the core value proposition.

The right framing is not "eliminate the layer" but "ensure the layer is as thin as possible." The Claude SDK adapter is the gold standard here: typed objects in, typed events out, no string parsing. As the other CLIs mature their SDK/API offerings, the adapters should follow this pattern.
