# Gemini ACP Deep Analysis

> Research date: 2026-03-16
> ACP SDK version: `@agentclientprotocol/sdk` v0.14.1
> Gemini CLI version: 0.31.0
> Copilot CLI version: 1.0.4
> Protocol version: 1

## 1. ACP Protocol — Complete Specification

### 1.1 What is ACP?

The **Agent Client Protocol** (ACP) is a JSON-RPC 2.0 protocol standardizing communication between code editors (clients) and coding agents. Created by Zed Industries, it is the "LSP for AI coding agents." Communication happens over NDJSON (newline-delimited JSON) on stdio for local agents, or HTTP/WebSocket for remote agents.

Official spec: https://agentclientprotocol.com/protocol/overview
SDK repo: https://github.com/agentclientprotocol/typescript-sdk

### 1.2 Roles

- **Client** = code editor / IDE / orchestrator (Agendo, Zed, JetBrains, Neovim, Emacs)
- **Agent** = coding agent process (Gemini CLI, Copilot CLI, Goose, Aider, etc.)

### 1.3 Complete RPC Method Catalog

#### Agent Methods (Client → Agent requests)

| Method                      | Stable?  | Description                                                                   |
| --------------------------- | -------- | ----------------------------------------------------------------------------- |
| `initialize`                | Yes      | Handshake, version/capability negotiation                                     |
| `session/new`               | Yes      | Create a new session with cwd + MCP servers                                   |
| `session/load`              | Yes\*    | Resume session with full history replay (\*requires `loadSession` capability) |
| `session/prompt`            | Yes      | Send user message, blocks until turn completes                                |
| `session/cancel`            | Yes      | Notification to cancel ongoing prompt turn                                    |
| `session/set_mode`          | Yes      | Switch permission/operational mode                                            |
| `session/set_model`         | Unstable | Change model mid-session                                                      |
| `session/set_config_option` | Yes      | Set a configuration option                                                    |
| `authenticate`              | Yes      | Authenticate with agent (e.g., OAuth)                                         |
| `session/resume`            | Unstable | Resume without history replay (faster than load)                              |
| `session/fork`              | Unstable | Branch a session into a new independent session                               |
| `session/list`              | Unstable | List existing sessions with metadata                                          |

#### Client Methods (Agent → Client requests/notifications)

| Method                       | Type         | Description                                 |
| ---------------------------- | ------------ | ------------------------------------------- |
| `session/update`             | Notification | Stream session updates (text, tools, plans) |
| `session/request_permission` | Request      | Ask user to approve tool call               |
| `fs/read_text_file`          | Request      | Read file from client filesystem            |
| `fs/write_text_file`         | Request      | Write file to client filesystem             |
| `terminal/create`            | Request      | Create terminal, execute command            |
| `terminal/output`            | Request      | Get current terminal output                 |
| `terminal/wait_for_exit`     | Request      | Wait for command completion                 |
| `terminal/kill`              | Request      | Kill terminal command                       |
| `terminal/release`           | Request      | Release terminal resources                  |

#### Extension Methods (both directions)

Both sides can send arbitrary `extMethod` (request) and `extNotification` (notification) for custom extensions beyond the spec.

### 1.4 Connection Lifecycle

```
Client                          Agent
  |                               |
  |--- initialize --------------->|  (version + capabilities)
  |<-- InitializeResponse --------|  (agent capabilities, auth methods)
  |                               |
  |--- session/new --------------->|  (cwd, MCP servers)
  |<-- NewSessionResponse ---------|  (sessionId, modes, models, configOptions)
  |                               |
  |--- session/prompt ------------->|  (sessionId, prompt content blocks)
  |<-- session/update (notif) -----|  (streaming: text, tools, plans)
  |<-- session/update (notif) -----|  ...
  |<-- request_permission -------->|  (tool needs approval)
  |--- PermissionResponse -------->|  (allow/deny/cancel)
  |<-- session/update (notif) -----|  (tool result)
  |<-- PromptResponse -------------|  (stopReason, usage)
  |                               |
  |--- session/prompt ------------->|  (next turn)
  |    ...                        |
```

### 1.5 Client Capabilities (what Agendo advertises)

```typescript
{
  terminal: true,          // Agent can create/run terminals
  fs: {
    readTextFile: true,    // Agent can read files
    writeTextFile: true,   // Agent can write files
  },
}
```

### 1.6 Agent Capabilities (what Gemini/Copilot advertise)

```typescript
type AgentCapabilities = {
  loadSession?: boolean; // session/load supported
  mcpCapabilities?: { http?: boolean; sse?: boolean }; // MCP transport types
  promptCapabilities?: { image?: boolean; audio?: boolean }; // Content types
  sessionCapabilities?: {
    fork?: SessionForkCapabilities; // session/fork
    list?: SessionListCapabilities; // session/list
    resume?: SessionResumeCapabilities; // session/resume
  };
};
```

## 2. Session Update Event Model (Complete)

The `session/update` notification carries a `SessionUpdate` discriminated union. Here are ALL subtypes:

### 2.1 Content Streaming

| `sessionUpdate`       | Payload        | Description                         |
| --------------------- | -------------- | ----------------------------------- |
| `user_message_chunk`  | `ContentChunk` | Echo of user message (rare)         |
| `agent_message_chunk` | `ContentChunk` | Streaming agent text/image output   |
| `agent_thought_chunk` | `ContentChunk` | Streaming thinking/reasoning output |

`ContentChunk.content` is a `ContentBlock`: `text`, `image`, `audio`, `resource_link`, or `resource`.

### 2.2 Tool Calls

| `sessionUpdate`    | Payload          | Description                            |
| ------------------ | ---------------- | -------------------------------------- |
| `tool_call`        | `ToolCall`       | New tool call started                  |
| `tool_call_update` | `ToolCallUpdate` | Progress/result for existing tool call |

`ToolCall` fields:

- `toolCallId` — unique ID
- `title` — human-readable description
- `kind` — one of: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`
- `status` — `pending` | `in_progress` | `completed` | `failed`
- `locations` — array of `{ path, line? }` (enables "follow the agent")
- `rawInput` — tool input parameters
- `rawOutput` — tool output
- `content` — array of `ToolCallContent` (text/diff/terminal)

`ToolCallContent` variants:

- `{ type: "content", content: ContentBlock }` — text/image result
- `{ type: "diff", newText, oldText?, path }` — file diff
- `{ type: "terminal", terminalId }` — embedded terminal output

### 2.3 Plans

| `sessionUpdate` | Payload | Description                                          |
| --------------- | ------- | ---------------------------------------------------- |
| `plan`          | `Plan`  | Execution plan (replaces entire plan on each update) |

`Plan.entries[]`:

- `content` — human-readable task description
- `priority` — `high` | `medium` | `low`
- `status` — `pending` | `in_progress` | `completed`

### 2.4 Session Metadata

| `sessionUpdate`             | Payload                 | Description                            |
| --------------------------- | ----------------------- | -------------------------------------- |
| `current_mode_update`       | `{ currentModeId }`     | Mode changed (e.g., yolo → default)    |
| `usage_update`              | `{ used, size, cost? }` | Context window usage + optional cost   |
| `available_commands_update` | `{ availableCommands }` | Slash commands available               |
| `config_option_update`      | `{ configOptions }`     | Config option changed                  |
| `session_info_update`       | `{ title?, cwd?, ... }` | Session metadata changed (e.g., title) |

### 2.5 Permission Flow

When agent needs approval (non-yolo mode):

```
Agent → Client: session/request_permission
  {
    sessionId,
    toolCall: ToolCallUpdate,    // What the tool is doing
    options: PermissionOption[]  // Choices for the user
  }

Client → Agent: response
  {
    outcome: {
      outcome: "selected",       // NESTED — "outcome.outcome"
      optionId: "..."            // ID from PermissionOption
    }
  }
  // OR
  { outcome: { outcome: "cancelled" } }
```

`PermissionOptionKind`: `allow_once`, `allow_always`, `reject_once`, `reject_always`

**CRITICAL Gemini quirk**: The response must be doubly nested: `{ outcome: { outcome: 'selected', optionId } }`. Gemini's internal Zod validation does `z.nativeEnum(ToolConfirmationOutcome).parse(output.outcome.optionId)` — so `output.outcome` must be an object, not a string.

### 2.6 Prompt Response

```typescript
type PromptResponse = {
  stopReason: StopReason; // "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"
  usage?: Usage; // { inputTokens, outputTokens, thoughtTokens?, cachedReadTokens?, cachedWriteTokens? }
};
```

## 3. Session Management Depth

### 3.1 session/new

Creates a fresh session. Params: `{ cwd, mcpServers }`. Returns: `{ sessionId, modes?, models?, configOptions? }`.

### 3.2 session/load (requires `loadSession` capability)

Replays FULL conversation history as `session/update` notifications. The client receives the entire history as streaming updates before the load response returns. This enables reconstructing conversation state from a cold start.

Params: `{ sessionId, cwd, mcpServers }`. Returns same shape as `session/new`.

### 3.3 session/resume (UNSTABLE, requires `sessionCapabilities.resume`)

Resumes WITHOUT history replay — faster than load. The agent picks up where it left off but the client doesn't get past messages. Good for Agendo since we maintain our own event log.

Params: `{ sessionId, cwd, mcpServers }`. Returns same shape as `session/new`.

### 3.4 session/list (UNSTABLE, requires `sessionCapabilities.list`)

Returns session metadata:

```typescript
type SessionInfo = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string; // ISO 8601
};
```

Supports filtering by `cwd` and cursor-based pagination.

### 3.5 session/fork (UNSTABLE, requires `sessionCapabilities.fork`)

Creates a new independent session branched from an existing one. Useful for generating summaries or exploring alternatives without affecting the original.

Params: `{ sessionId, cwd, mcpServers }`. Returns new session with its own `sessionId`.

### 3.6 Session Persistence Outside ACP

Gemini CLI stores sessions on disk at `~/.gemini/tmp/<project-hash>/<session-id>/`. Session data includes conversation history, plan state, and tool results. These files persist across process restarts, enabling `session/load` and `session/resume`.

**A second ACP client CANNOT connect to an existing running session.** ACP is a 1:1 stdio connection. To observe a session, you'd need to be the original client or load the session from disk.

### 3.7 Agendo's Resume Strategy

Agendo uses a 3-path fallback (in `gemini-acp-transport.ts`):

1. `session/resume` (fastest — no history replay)
2. `session/load` (if resume unavailable — replays history)
3. `session/new` (if no prior session exists)

This is correct and optimal. The `resumeSessionId` is stored in Agendo's DB as `sessionRef`.

## 4. Modes and Models

### 4.1 Session Modes

Modes are permission/operational presets. Set via `session/set_mode`.

Gemini's mode IDs:

- `default` — prompt for each tool approval
- `autoEdit` — auto-approve file edits, prompt for shell commands
- `yolo` — auto-approve everything
- `plan` — read-only, builds plan but doesn't execute (NOT settable via ACP `set_mode` — returns -32603)

Agendo's mapping (`gemini-adapter.ts`):

```
default     → "default"
acceptEdits → "autoEdit"
bypassPermissions → "yolo"
dontAsk     → "yolo"
plan        → passed as CLI arg (--approval-mode plan), NOT via set_mode
```

### 4.2 Model Selection

`session/set_model` (UNSTABLE) allows changing model mid-session. Gemini requires killing and restarting the process with the new `-m` flag (Agendo implements this in `GeminiAdapter.setModel()`). Copilot exposes `unstable_setSessionModel` via ACP directly.

## 5. Gemini vs Copilot ACP Comparison

### 5.1 Shared Architecture

Both Gemini and Copilot use ACP over stdio with NDJSON framing. Agendo shares the `AcpTransport` class between both adapters. Both implement the same `Client` interface.

### 5.2 Differences

| Feature                | Gemini CLI                                | Copilot CLI                           |
| ---------------------- | ----------------------------------------- | ------------------------------------- |
| ACP flag               | `--experimental-acp`                      | `--acp`                               |
| Version                | 0.31.0                                    | 1.0.4                                 |
| MCP injection          | `mcpServers` in session/new               | `--additional-mcp-config` CLI flag    |
| MCP server filtering   | `--allowed-mcp-server-names`              | `--disable-builtin-mcps`              |
| Resume                 | Via ACP `session/resume` / `session/load` | Via `--resume=<id>` CLI flag          |
| Model switch           | Kill + restart process                    | `unstable_setSessionModel` ACP method |
| Permission modes       | `--approval-mode` CLI flag                | `--yolo` / `--allow-all-tools` flags  |
| Plan mode              | `--approval-mode plan` (works)            | Not exposed                           |
| Custom commands        | TOML files in `.gemini/commands/`         | Not supported                         |
| Slash commands via ACP | `available_commands_update`               | `available_commands_update`           |
| Tool call IDs          | `toolCallId` pattern                      | `toolCallId` pattern                  |
| Session persistence    | `~/.gemini/tmp/`                          | `~/.copilot/sessions/`                |
| Policy engine          | `--policy` flag                           | Not supported                         |

### 5.3 Copilot-Specific Features

- `--disable-builtin-mcps` — disables built-in GitHub MCP server
- `--add-github-mcp-tool` / `--add-github-mcp-toolset` — fine-grained GitHub MCP tool control
- `--autopilot` — auto-continue in prompt mode
- `--agent <agent>` — custom agent selection
- TCP transport: `copilot --acp --port 8080`

### 5.4 Client Handler Similarity

`GeminiClientHandler` and `CopilotClientHandler` are nearly identical (same structure, same `sessionUpdate` switch). They differ only in:

- Event type prefixes (`gemini:*` vs `copilot:*`)
- Copilot doesn't merge TOML custom commands

## 6. IDE Integration Patterns

### 6.1 Zed

Zed created ACP and is the reference client. It spawns agents as child processes, communicates over stdio/NDJSON, and renders the streaming updates in its agent panel. Zed maintains the official ACP Agent Registry.

### 6.2 JetBrains

JetBrains adopted ACP in their 2025.3+ IDEs. Configuration via `~/.jetbrains/acp.json` or via the ACP Agent Registry. They render tool calls, plans, and permissions in the AI Assistant panel.

### 6.3 Common Pattern

All IDE integrations:

1. Spawn the agent CLI with ACP flag
2. Run the `initialize` → `session/new` handshake
3. Send prompts, receive streaming `session/update` notifications
4. Handle `request_permission` for tool approvals
5. Render text chunks, tool calls, plans, and diffs in their UI
6. **They do NOT maintain their own log files** — they rely entirely on ACP events
7. They do NOT maintain separate event formats — ACP events ARE the data model

## 7. Key Answers to Strategic Questions

### 7.1 Does ACP provide enough to reconstruct full conversation state?

**YES**, with caveats:

- `session/load` replays the ENTIRE conversation history as `session/update` notifications
- Each update contains text chunks, tool calls (with content/diffs/terminals), plans, and mode changes
- Token usage via `usage_update` provides context window stats
- `session_info_update` provides title and metadata
- **Missing**: There's no explicit "message boundary" event. You reconstruct message boundaries from the prompt/response cycle.

### 7.2 Can a second ACP client connect to an existing session?

**NO.** ACP is a 1:1 stdio connection. Only one client controls a session at a time. To observe, you must be the original client.

### 7.3 What's the MINIMUM Agendo needs on top of ACP?

Agendo's adapter layer adds:

1. **Event normalization** — `GeminiEvent` → `AgendoEventPayload` mapping (already implemented)
2. **Session persistence** — Agendo stores `sessionRef` for resume, log files for history
3. **Multi-turn orchestration** — lock + currentTurn promise chain (ACP prompt blocks until complete)
4. **Process management** — spawn/kill/restart with PM2-aware lifecycle
5. **Permission routing** — Agendo's approval handler integrates with its own UI
6. **Model switch** — Gemini requires process restart (Copilot doesn't)

Most of this is already implemented. The adaptation layer is thin.

### 7.4 Could ACP events be forwarded directly to SSE without intermediate format?

**Partially.** The `SessionUpdate` types are rich enough, but:

- ACP events don't include session/execution metadata (task links, Agendo IDs)
- The `session/update` notification wraps everything in `{ sessionId, update: { sessionUpdate: "...", ...payload } }` — you'd need to flatten
- Tool call tracking (start/end pairing) differs between yolo mode (via `tool_call`/`tool_call_update`) and default mode (via `request_permission`)
- Agendo's `AgendoEventPayload` is simpler and agent-agnostic — it's the right abstraction

**Recommendation**: Keep the current adapter pattern. It's already thin and the normalization adds real value.

## 8. Gaps and Opportunities

### 8.1 Features Agendo Doesn't Use Yet

| ACP Feature             | Status in Agendo                       | Value                                         |
| ----------------------- | -------------------------------------- | --------------------------------------------- |
| `session/fork`          | Not used                               | Could enable "what if" branching UI           |
| `session/list`          | Not used                               | Could sync session list from agent            |
| `session_info_update`   | Not handled                            | Auto-title sessions                           |
| `config_option_update`  | Not handled                            | Dynamic config UI                             |
| `terminal/create`       | Not implemented                        | Agent could run commands in Agendo's terminal |
| `Diff` content type     | Not rendered                           | Show file diffs inline                        |
| `Cost` in UsageUpdate   | Not used                               | Show cumulative $ cost                        |
| Extension methods       | Not used                               | Custom Agendo↔Agent communication             |
| `agent_thought_chunk`   | Mapped but not differentially rendered | Show thinking separately                      |
| TCP transport (Copilot) | Not used                               | Could avoid stdio complexity                  |

### 8.2 Current Limitations

1. **Plan mode via ACP**: Gemini rejects `session/set_mode` with `plan` mode ID (-32603). Must use CLI arg at startup. Cannot switch to/from plan mode mid-session via ACP.

2. **Model switch**: Gemini requires full process restart. This is expensive (~5-10s) and loses the ACP connection temporarily.

3. **No multi-client**: Can't have a "read-only observer" on an active session via ACP.

4. **No explicit message boundaries**: Must infer from prompt/response cycle timing.

5. **Tool call pairing**: In yolo mode, tool_call/tool_call_update events are separate from permission handler events. Agendo uses `activeToolCalls` Set to track this correctly but it's fragile.

### 8.3 Terminal Protocol (Not Yet Implemented by Agendo)

ACP includes a full terminal protocol where the agent can request terminal creation from the client:

```
Agent → Client: terminal/create { command, args, cwd, env, sessionId }
Client → Agent: { terminalId }
Agent → Client: terminal/output { terminalId, sessionId }
Client → Agent: { output, exitStatus? }
Agent → Client: terminal/wait_for_exit { terminalId, sessionId }
Client → Agent: { exitStatus }
Agent → Client: terminal/release { terminalId, sessionId }
```

Agendo advertises `terminal: true` in capabilities but doesn't implement the handlers. This means Gemini/Copilot can request terminal execution through ACP, and Agendo could route these to its existing xterm.js terminal server.

## 9. Agendo's Current ACP Implementation Quality

### 9.1 What's Done Well

- **Shared transport**: `AcpTransport` class used by both Gemini and Copilot — no duplication
- **3-path resume**: resume → load → new fallback is optimal
- **Permission nesting**: The `{ outcome: { outcome: 'selected', optionId } }` nesting is correct
- **Tool call tracking**: `activeToolCalls` Set correctly handles yolo vs default mode
- **Model switch**: Full process restart with connection re-creation for Gemini
- **Event normalization**: Clean mapping from agent-specific events to `AgendoEventPayload`
- **MCP server injection**: Correctly formats env as `[{name, value}]` for ACP
- **Custom command merging**: TOML commands merged with ACP `available_commands_update`
- **429 retry**: Initialize retries with exponential backoff

### 9.2 What Could Be Improved

1. **Terminal protocol handlers**: Implement `createTerminal`, `terminalOutput`, `waitForTerminalExit`, `killTerminal`, `releaseTerminal` in client handlers
2. **Diff rendering**: `ToolCallContent` with `type: "diff"` not handled in event mapper
3. **Session info updates**: `session_info_update` not handled — could auto-title sessions
4. **Cost tracking**: `UsageUpdate.cost` not extracted
5. **Config options**: `config_option_update` and `setSessionConfigOption` not used
6. **Extension methods**: Could use `extMethod`/`extNotification` for custom Agendo↔Agent communication

## 10. Summary

ACP is a well-designed, comprehensive protocol that Agendo already implements correctly for the core use cases. The main untapped features are terminal delegation, diff rendering, session forking, and cost tracking. The current adapter pattern (ACP → agent-specific events → AgendoEventPayload) is the right architecture — it's thin, correct, and provides agent-agnostic normalization.

Both Gemini and Copilot use nearly identical ACP implementations, validating the "shared AcpTransport" design decision. The protocol is stable for core features (init, sessions, prompts, updates, permissions) with session management extensions (resume, fork, list) still marked unstable.
