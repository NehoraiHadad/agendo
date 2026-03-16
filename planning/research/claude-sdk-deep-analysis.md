# Claude SDK Deep Analysis

> Research date: 2026-03-16
> SDK version: `@anthropic-ai/claude-agent-sdk@0.2.72` (bundled with Claude Code 2.1.76)
> Package: `@anthropic-ai/claude-agent-sdk` — npm/GitHub: `anthropics/claude-agent-sdk-typescript`

---

## 1. SDK Architecture Overview

The `@anthropic-ai/claude-agent-sdk` is NOT a simple API wrapper. It is the Claude Code TUI itself, packaged as an embeddable Node.js library. The SDK spawns a Claude Code CLI subprocess and communicates with it over stdin/stdout using NDJSON — the same protocol the TUI uses internally. The SDK wraps this in a typed `AsyncGenerator<SDKMessage>` interface.

Key insight: **everything the TUI shows is available through the SDK** because the SDK IS the TUI engine.

### Exports

```typescript
// Main API (stable)
export function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
export function listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
export function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>;
export function createSdkMcpServer(
  options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance;
export function tool<Schema>(
  name,
  description,
  inputSchema,
  handler,
  extras?,
): SdkMcpToolDefinition<Schema>;

// V2 API (UNSTABLE, @alpha)
export function unstable_v2_createSession(options: SDKSessionOptions): SDKSession;
export function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage>;
export function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions,
): SDKSession;

// Embed (just exports the CLI path)
import cliPath from '@anthropic-ai/claude-agent-sdk/embed';
```

---

## 2. The `query()` Function — Primary API

```typescript
function query(params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;
```

### Input Modes

1. **Single prompt** (`prompt: string`) — one-shot execution, returns result
2. **Streaming input** (`prompt: AsyncIterable<SDKUserMessage>`) — multi-turn conversations

Agendo uses mode 2: an `AsyncQueue<SDKUserMessage>` feeds messages into the query as they arrive from the frontend.

### The `Query` Interface

`Query extends AsyncGenerator<SDKMessage, void>` — iterate with `for await (const msg of query)`.

#### Control Methods (only in streaming input mode)

| Method                           | Description                                        |
| -------------------------------- | -------------------------------------------------- |
| `interrupt()`                    | Stop current turn                                  |
| `setPermissionMode(mode)`        | Change permission mode live                        |
| `setModel(model?)`               | Switch model mid-session                           |
| `setMaxThinkingTokens(n)`        | Adjust thinking budget (deprecated)                |
| `initializationResult()`         | Get full init response (commands, models, account) |
| `supportedCommands()`            | List available slash commands                      |
| `supportedModels()`              | List available models with capabilities            |
| `supportedAgents()`              | List available subagents                           |
| `mcpServerStatus()`              | Get MCP server connection status                   |
| `accountInfo()`                  | Get account info (email, org, subscription)        |
| `rewindFiles(messageId, opts?)`  | Rewind file changes to a checkpoint                |
| `reconnectMcpServer(name)`       | Reconnect a failed MCP server                      |
| `toggleMcpServer(name, enabled)` | Enable/disable MCP server                          |
| `setMcpServers(servers)`         | Replace dynamic MCP servers                        |
| `streamInput(stream)`            | Internal: pipe additional messages                 |
| `stopTask(taskId)`               | Stop a running subagent task                       |
| `close()`                        | Terminate the query and subprocess                 |

### The `Options` Object

Comprehensive configuration — key fields:

| Option                       | Type                                                | Purpose                               |
| ---------------------------- | --------------------------------------------------- | ------------------------------------- |
| `cwd`                        | `string`                                            | Working directory                     |
| `model`                      | `string`                                            | Claude model ID                       |
| `effort`                     | `'low'\|'medium'\|'high'\|'max'`                    | Thinking effort level                 |
| `permissionMode`             | `PermissionMode`                                    | Tool approval mode                    |
| `allowedTools`               | `string[]`                                          | Auto-allowed tools                    |
| `disallowedTools`            | `string[]`                                          | Blocked tools                         |
| `tools`                      | `string[]\|{preset:'claude_code'}`                  | Available tool set                    |
| `mcpServers`                 | `Record<string, McpServerConfig>`                   | MCP server configs                    |
| `canUseTool`                 | `CanUseTool`                                        | Permission callback                   |
| `hooks`                      | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | In-process hook callbacks             |
| `agents`                     | `Record<string, AgentDefinition>`                   | Custom subagent definitions           |
| `agent`                      | `string`                                            | Main thread agent name                |
| `systemPrompt`               | `string \| {preset,append}`                         | System prompt config                  |
| `resume`                     | `string`                                            | Session ID to resume                  |
| `sessionId`                  | `string`                                            | Force specific session UUID           |
| `resumeSessionAt`            | `string`                                            | Resume up to specific message UUID    |
| `forkSession`                | `boolean`                                           | Fork instead of continuing            |
| `persistSession`             | `boolean`                                           | Save to disk (default true)           |
| `includePartialMessages`     | `boolean`                                           | Enable stream_event deltas            |
| `enableFileCheckpointing`    | `boolean`                                           | Track file changes for rewind         |
| `outputFormat`               | `JsonSchemaOutputFormat`                            | Structured output schema              |
| `maxBudgetUsd`               | `number`                                            | Budget cap                            |
| `maxTurns`                   | `number`                                            | Turn limit                            |
| `fallbackModel`              | `string`                                            | Fallback model                        |
| `thinking`                   | `ThinkingConfig`                                    | Thinking mode config                  |
| `promptSuggestions`          | `boolean`                                           | Enable predicted next prompts         |
| `agentProgressSummaries`     | `boolean`                                           | Enable subagent progress summaries    |
| `settingSources`             | `SettingSource[]`                                   | Which settings files to load          |
| `sandbox`                    | `SandboxSettings`                                   | Sandbox config                        |
| `settings`                   | `string\|Settings`                                  | Additional settings                   |
| `plugins`                    | `SdkPluginConfig[]`                                 | Load plugins                          |
| `betas`                      | `SdkBeta[]`                                         | Beta features (e.g. 1M context)       |
| `spawnClaudeCodeProcess`     | function                                            | Custom process spawner (VM/container) |
| `onElicitation`              | function                                            | MCP elicitation handler               |
| `debug`                      | `boolean`                                           | Enable debug logging                  |
| `debugFile`                  | `string`                                            | Debug log file path                   |
| `stderr`                     | `(data: string) => void`                            | Stderr callback                       |
| `pathToClaudeCodeExecutable` | `string`                                            | Custom CLI path                       |
| `env`                        | `Record<string, string>`                            | Environment variables                 |

---

## 3. SDKMessage — Complete Type Catalog

`SDKMessage` is a discriminated union of 22 message types:

### Core Conversation Messages

| Type                   | Discriminant                 | Key Fields                                                                                                                                                   | Purpose                                                       |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `SDKAssistantMessage`  | `type:'assistant'`           | `message: BetaMessage`, `uuid`, `error?`, `parent_tool_use_id`                                                                                               | Assistant turn with content blocks (text, thinking, tool_use) |
| `SDKUserMessage`       | `type:'user'`                | `message: MessageParam`, `uuid?`, `tool_use_result?`, `priority?`                                                                                            | User turn (text or tool_result blocks)                        |
| `SDKUserMessageReplay` | `type:'user', isReplay:true` | Same as SDKUserMessage + `isReplay:true`                                                                                                                     | Replayed message during resume                                |
| `SDKResultMessage`     | `type:'result'`              | `subtype`, `total_cost_usd`, `num_turns`, `duration_ms`, `modelUsage`, `usage`, `permission_denials`, `is_error`, `errors?`, `result?`, `structured_output?` | Turn completion with stats                                    |

### System Messages (`type:'system'`)

| Subtype                | Type Name                       | Key Fields                                                                                                                              | Purpose                                |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `init`                 | `SDKSystemMessage`              | `session_id`, `model`, `tools[]`, `mcp_servers[]`, `permissionMode`, `slash_commands[]`, `skills[]`, `plugins[]`, `apiKeySource`, `cwd` | Session initialization                 |
| `compact_boundary`     | `SDKCompactBoundaryMessage`     | `compact_metadata: {trigger, pre_tokens}`                                                                                               | Conversation compaction marker         |
| `status`               | `SDKStatusMessage`              | `status: 'compacting'\|null`, `permissionMode?`                                                                                         | Status changes                         |
| `hook_started`         | `SDKHookStartedMessage`         | `hook_id`, `hook_name`, `hook_event`                                                                                                    | Hook execution started                 |
| `hook_progress`        | `SDKHookProgressMessage`        | `hook_id`, `stdout`, `stderr`, `output`                                                                                                 | Hook in-progress output                |
| `hook_response`        | `SDKHookResponseMessage`        | `hook_id`, `exit_code`, `outcome`                                                                                                       | Hook completed                         |
| `local_command_output` | `SDKLocalCommandOutputMessage`  | `content`                                                                                                                               | Output from /voice, /cost, etc.        |
| `task_notification`    | `SDKTaskNotificationMessage`    | `task_id`, `status`, `output_file`, `summary`, `usage?`                                                                                 | Subagent task completed/failed/stopped |
| `task_started`         | `SDKTaskStartedMessage`         | `task_id`, `description`, `prompt?`                                                                                                     | Subagent task started                  |
| `task_progress`        | `SDKTaskProgressMessage`        | `task_id`, `description`, `usage`, `last_tool_name?`, `summary?`                                                                        | Subagent progress update               |
| `files_persisted`      | `SDKFilesPersistedEvent`        | `files[]`, `failed[]`                                                                                                                   | File persistence status                |
| `elicitation_complete` | `SDKElicitationCompleteMessage` | `mcp_server_name`, `elicitation_id`                                                                                                     | MCP elicitation done                   |

### Streaming & Other

| Type                | Type Name                    | Key Fields                                         | Purpose                                                                 |
| ------------------- | ---------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `stream_event`      | `SDKPartialAssistantMessage` | `event: BetaRawMessageStreamEvent`                 | Token-level streaming (text_delta, thinking_delta, message_start, etc.) |
| `tool_progress`     | `SDKToolProgressMessage`     | `tool_use_id`, `tool_name`, `elapsed_time_seconds` | Long-running tool progress                                              |
| `tool_use_summary`  | `SDKToolUseSummaryMessage`   | `summary`, `preceding_tool_use_ids[]`              | Collapsed tool use summary                                              |
| `auth_status`       | `SDKAuthStatusMessage`       | `isAuthenticating`, `output[]`, `error?`           | Auth progress                                                           |
| `rate_limit_event`  | `SDKRateLimitEvent`          | `rate_limit_info: SDKRateLimitInfo`                | Rate limit status changes                                               |
| `prompt_suggestion` | `SDKPromptSuggestionMessage` | `suggestion`                                       | Predicted next user prompt                                              |

### Result Subtypes

| Subtype                               | Meaning                              |
| ------------------------------------- | ------------------------------------ |
| `success`                             | Normal completion with `result` text |
| `error_during_execution`              | Error occurred                       |
| `error_max_turns`                     | Hit turn limit                       |
| `error_max_budget_usd`                | Hit budget cap                       |
| `error_max_structured_output_retries` | Structured output validation failed  |

### ModelUsage (per-model breakdown)

```typescript
type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
};
```

---

## 4. Session Management APIs

### `listSessions(options?)`

```typescript
function listSessions(options?: {
  dir?: string; // Project directory (omit for all projects)
  limit?: number; // Max sessions to return
  includeWorktrees?: boolean; // Include worktree sessions (default true)
}): Promise<SDKSessionInfo[]>;
```

Returns:

```typescript
type SDKSessionInfo = {
  sessionId: string; // UUID
  summary: string; // Display title
  lastModified: number; // Epoch ms
  fileSize: number; // Bytes
  customTitle?: string; // User-set title (/rename)
  firstPrompt?: string; // First user message
  gitBranch?: string; // Branch at session end
  cwd?: string; // Working directory
};
```

**This reads directly from the JSONL files on disk** — no running process needed.

### `getSessionMessages(sessionId, options?)`

```typescript
function getSessionMessages(
  sessionId: string,
  options?: {
    dir?: string; // Project directory (searches all if omitted)
    limit?: number; // Max messages
    offset?: number; // Skip N messages
  },
): Promise<SessionMessage[]>;
```

Returns:

```typescript
type SessionMessage = {
  type: 'user' | 'assistant';
  uuid: string;
  session_id: string;
  message: unknown; // MessageParam content (text/blocks)
  parent_tool_use_id: null;
};
```

**Parses the JSONL transcript, builds the conversation chain via `parentUuid` links, returns chronological user/assistant messages.** No running process needed.

### Resume/Fork

- `options.resume = sessionId` — resumes from where the session left off
- `options.resumeSessionAt = messageUuid` — resumes up to a specific message
- `options.forkSession = true` — creates a new session ID from the resume point
- `options.sessionId = uuid` — force a specific session ID
- `options.continue = true` — continue most recent session in the directory

---

## 5. JSONL Transcript Format

Location: `~/.claude/projects/{project-path-slug}/{sessionId}.jsonl`

### Directory Structure

```
~/.claude/
├── history.jsonl                    # Global prompt history (display text only)
├── projects/
│   └── -home-ubuntu-projects-agendo/
│       ├── {sessionId}.jsonl        # Full session transcript
│       ├── {sessionId}/             # Session-specific data
│       │   └── subagents/           # Subagent transcripts
│       │       ├── agent-{taskId}.jsonl
│       │       └── agent-{taskId}.meta.json
│       └── memory/                  # Project memory files
```

### Record Types Found in JSONL

| Type                       | Count (sample) | Description                                            |
| -------------------------- | -------------- | ------------------------------------------------------ |
| `user`                     | 392            | User messages (text + tool_result blocks)              |
| `assistant`                | 569            | Assistant messages (text + thinking + tool_use blocks) |
| `progress`                 | 190            | Hook/tool progress updates                             |
| `queue-operation`          | 68             | Message queue enqueue/dequeue                          |
| `system:compact_boundary`  | 1              | Compaction marker                                      |
| `system:stop_hook_summary` | 31             | Stop hook results                                      |
| `system:turn_duration`     | 11             | Turn timing data                                       |
| `file-history-snapshot`    | 13             | File checkpoint snapshots                              |
| `last-prompt`              | 5              | Last prompt for session resume                         |

### Record Schema

Every record shares these fields:

```json
{
  "type": "user|assistant|progress|system:*|queue-operation|file-history-snapshot|last-prompt",
  "uuid": "UUID",
  "timestamp": "ISO-8601",
  "sessionId": "UUID",
  "cwd": "/path/to/working/dir",
  "version": "2.1.76",
  "gitBranch": "main"
}
```

#### User Record

```json
{
  "type": "user",
  "parentUuid": "UUID of parent assistant message",
  "isSidechain": false,
  "message": {
    "role": "user",
    "content": "text" | [{ "type": "tool_result", "tool_use_id": "...", "content": "..." }]
  },
  "toolUseResult": { "success": true, "commandName": "..." },
  "sourceToolAssistantUUID": "UUID",
  "promptId": "UUID",
  "userType": "external"
}
```

#### Assistant Record

```json
{
  "type": "assistant",
  "parentUuid": "UUID of parent user message",
  "isSidechain": false,
  "requestId": "req_...",
  "message": {
    "model": "claude-sonnet-4-6",
    "id": "msg_...",
    "type": "message",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "..." },
      { "type": "thinking", "thinking": "..." },
      { "type": "tool_use", "id": "toolu_...", "name": "Bash", "input": {...}, "caller": {"type":"direct"} }
    ],
    "stop_reason": "tool_use|end_turn",
    "usage": {
      "input_tokens": 3,
      "cache_creation_input_tokens": 24469,
      "cache_read_input_tokens": 0,
      "output_tokens": 138,
      "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
      "service_tier": "standard",
      "inference_geo": "",
      "speed": "standard"
    }
  }
}
```

#### Queue-Operation Record

```json
{
  "type": "queue-operation",
  "operation": "enqueue",
  "timestamp": "ISO-8601",
  "sessionId": "UUID",
  "content": "full prompt text..."
}
```

#### Progress Record

```json
{
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "Stop",
    "hookName": "Stop",
    "command": "/path/to/hook.sh"
  },
  "parentToolUseID": "UUID",
  "toolUseID": "UUID",
  "slug": "federated-jumping-giraffe"
}
```

#### Subagent Meta

```json
{
  "agentType": "senior-frontend-dev"
}
```

### Conversation Tree Reconstruction

The `parentUuid` field on every user/assistant record forms a linked list (actually a tree for branching conversations). `getSessionMessages()` already implements the chain-walking algorithm. You can reconstruct the full conversation from JSONL alone — the SDK does exactly this for `--resume`.

---

## 6. Stream Events (Token-Level Streaming)

When `includePartialMessages: true` (which Agendo uses), the SDK emits `SDKPartialAssistantMessage`:

```typescript
type SDKPartialAssistantMessage = {
  type: 'stream_event';
  event: BetaRawMessageStreamEvent; // Anthropic API stream events
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
};
```

### Stream Event Subtypes

These are standard Anthropic API stream events:

| Event Type            | Content                                     | Purpose                              |
| --------------------- | ------------------------------------------- | ------------------------------------ |
| `message_start`       | `message.usage` (input_tokens, cache stats) | Start of API call with context stats |
| `content_block_start` | Block type declaration                      | New text/thinking/tool_use block     |
| `content_block_delta` | `delta.text` or `delta.thinking`            | Token-level text/thinking increments |
| `content_block_stop`  | Block end                                   | Block completed                      |
| `message_delta`       | `stop_reason`, `usage.output_tokens`        | Message completion                   |
| `message_stop`        | —                                           | Message fully done                   |

### How Agendo Uses Stream Events

1. `message_start` → extract per-call token stats via `onMessageStart` callback
2. `content_block_delta` with `text_delta` → `appendDelta()` → batched PG NOTIFY every 200ms
3. `content_block_delta` with `thinking_delta` → `appendThinkingDelta()` → batched thinking updates
4. Complete `assistant` message arrives after all deltas → `clearDeltaBuffers()` + emit full `agent:text`

Stream events are NOT persisted to the Agendo log file — only complete messages are logged.

---

## 7. V2 API (Unstable)

A cleaner session-based API exists but is marked `@alpha`:

```typescript
// Create a new session
const session: SDKSession = unstable_v2_createSession(options);

// Resume an existing session
const session: SDKSession = unstable_v2_resumeSession(sessionId, options);

// One-shot prompt
const result: SDKResultMessage = await unstable_v2_prompt('What files?', options);
```

### SDKSession Interface

```typescript
interface SDKSession {
  readonly sessionId: string; // Available after first message
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}
```

This is conceptually cleaner than the `query()` + `AsyncQueue` pattern Agendo currently uses, but the V2 API is unstable and lacks the rich control methods (setModel, setPermissionMode, etc.) available on `Query`.

---

## 8. SDK Hooks System

The SDK provides in-process TypeScript hook callbacks — distinct from the shell-based `.claude/hooks/` system:

```typescript
hooks: {
  PreToolUse: [{
    matcher?: 'Bash',  // optional tool name filter
    hooks: [async (input, toolUseID, { signal }) => {
      return { continue: true };
    }],
    timeout?: 30  // seconds
  }]
}
```

### All Hook Events (21 total)

| Event                | Fires When                                    |
| -------------------- | --------------------------------------------- |
| `PreToolUse`         | Before tool execution                         |
| `PostToolUse`        | After successful tool execution               |
| `PostToolUseFailure` | After failed tool execution                   |
| `PermissionRequest`  | Permission needed for tool                    |
| `Notification`       | Agent sends notification                      |
| `UserPromptSubmit`   | User submits prompt                           |
| `SessionStart`       | Session begins (startup/resume/clear/compact) |
| `SessionEnd`         | Session ends                                  |
| `Stop`               | Agent stops                                   |
| `SubagentStart`      | Subagent spawned                              |
| `SubagentStop`       | Subagent finished                             |
| `PreCompact`         | Before compaction                             |
| `Setup`              | First-time setup                              |
| `TeammateIdle`       | Teammate agent is idle                        |
| `TaskCompleted`      | Subagent task completed                       |
| `Elicitation`        | MCP server requests user input                |
| `ElicitationResult`  | Elicitation response                          |
| `ConfigChange`       | Settings changed                              |
| `WorktreeCreate`     | Git worktree created                          |
| `WorktreeRemove`     | Git worktree removed                          |
| `InstructionsLoaded` | CLAUDE.md or memory file loaded               |

Every hook receives `BaseHookInput`:

```typescript
type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  agent_id?: string; // Present in subagent context
  agent_type?: string; // Agent type name
};
```

---

## 9. Key Questions Answered

### Can I read full conversation history WITHOUT spawning a Claude process?

**YES.** Two ways:

1. **`getSessionMessages(sessionId, { dir })`** — SDK function that parses the JSONL on disk and returns chronological user/assistant messages. No subprocess needed.

2. **Direct JSONL parsing** — Read `~/.claude/projects/{slug}/{sessionId}.jsonl`, parse line-by-line, follow `parentUuid` chain. This gives you everything including progress events, hook data, and tool results that `getSessionMessages()` filters out.

### Can a second process observe events from a running Claude session?

**NO, not directly.** The SDK communicates with its subprocess over stdin/stdout pipes — there is no IPC, socket, or file-based pub/sub for external observers. However:

- The JSONL file is written in real-time (append-only). You could `tail -f` the JSONL for near-real-time observation, though you'd miss stream_event deltas (they aren't persisted).
- Agendo's approach (PG NOTIFY bridge) is the correct pattern for real-time external observation.
- There is no "attach to running session" API.

### What's the MINIMUM Agendo needs vs what Claude already provides?

**Claude already provides:**

- Full session persistence (JSONL)
- Session listing and message retrieval
- Resume/fork with message-level precision
- Token streaming
- Tool approval callbacks
- MCP server management
- Model/permission mode switching
- File checkpointing and rewind
- Subagent orchestration
- Hook system

**Agendo adds (and must continue to add):**

- Multi-agent orchestration (Claude, Codex, Gemini, Copilot)
- Real-time multiplexing (PG NOTIFY → SSE to multiple frontends)
- Task/Kanban workflow management
- Cross-agent session discovery
- Custom MCP tools (task management, agent spawning)
- Permission delegation (approval routing from headless agents to UI)
- Centralized logging and cost tracking

### Could Agendo read JSONL directly instead of maintaining its own log?

**Partially.** The JSONL has richer data than Agendo's log in some ways (full API usage per message, parentUuid tree, git branch, etc.). But:

1. JSONL doesn't contain stream_event deltas (no token streaming from file)
2. JSONL is Claude-specific — Codex/Gemini/Copilot have different formats
3. JSONL location depends on Claude's internal path resolution
4. Agendo's log format is agent-agnostic (AgendoEventPayload)

**Recommendation:** Use `getSessionMessages()` for session reconstruction/replay, but keep the real-time PG NOTIFY pipeline for live streaming.

---

## 10. SDK MCP Server (In-Process)

The SDK can host MCP tools in the same Node.js process:

```typescript
const server = createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [
    tool('my_tool', 'Does something', { input: z.string() }, async (args) => ({
      content: [{ type: 'text', text: 'result' }],
    })),
  ],
});

// Pass to query options
query({ prompt: '...', options: { mcpServers: { 'my-tools': server } } });
```

This avoids stdio transport overhead — tools run in-process. Could be used for Agendo's MCP tools instead of the current external stdio server.

---

## 11. Custom Subagents (Programmatic)

```typescript
query({
  prompt: '...',
  options: {
    agent: 'code-reviewer', // Main thread agent
    agents: {
      'code-reviewer': {
        description: 'Reviews code for best practices',
        prompt: 'You are a code reviewer...',
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        model: 'sonnet', // 'sonnet' | 'opus' | 'haiku' | 'inherit'
        maxTurns: 10,
        mcpServers: ['agendo'],
        skills: ['review'],
      },
      'test-runner': {
        description: 'Runs tests',
        prompt: 'Run tests...',
        tools: ['Bash', 'Read'],
      },
    },
  },
});
```

---

## 12. Permission System

### CanUseTool Callback

```typescript
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[]; // "always allow" suggestions
    blockedPath?: string;
    decisionReason?: string;
    toolUseID: string;
    agentID?: string; // Subagent context
  },
) => Promise<PermissionResult>;

type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: PermissionUpdate[];
    }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

Key capabilities:

- **`updatedInput`** — modify tool input before execution (Agendo uses this for editing tool calls)
- **`updatedPermissions`** — persist permission rules (e.g., "always allow Bash in /tmp")
- **`interrupt`** — stop the entire turn, not just deny the tool
- **`agentID`** — distinguish main thread from subagent permission requests

### Permission Modes

| Mode                | Behavior                                                            |
| ------------------- | ------------------------------------------------------------------- |
| `default`           | Prompts for dangerous tools                                         |
| `acceptEdits`       | Auto-allows file Edit/Write/Read; blocks Bash and MCP               |
| `bypassPermissions` | Auto-allows everything (requires `allowDangerouslySkipPermissions`) |
| `plan`              | Planning mode — tools are not executed                              |
| `dontAsk`           | Don't prompt — deny if not pre-approved                             |

---

## 13. What Agendo Uses Today

From `claude-sdk-adapter.ts` and `build-sdk-options.ts`:

| SDK Feature                                    | Agendo Usage                |
| ---------------------------------------------- | --------------------------- |
| `query()` with AsyncIterable                   | Multi-turn sessions         |
| `canUseTool` callback                          | Permission delegation to UI |
| `setPermissionMode()`                          | In-session mode changes     |
| `setModel()`                                   | In-session model switching  |
| `setMcpServers()`                              | Dynamic MCP server config   |
| `reconnectMcpServer()`                         | MCP health recovery         |
| `toggleMcpServer()`                            | Enable/disable MCP          |
| `mcpServerStatus()`                            | MCP health checks           |
| `rewindFiles()`                                | File checkpoint rewind      |
| `supportedCommands()`                          | Slash command enrichment    |
| `interrupt()`                                  | User-initiated stop         |
| `close()`                                      | Session termination         |
| `includePartialMessages`                       | Token streaming             |
| `settingSources: ['user','project','local']`   | Load user settings          |
| `persistSession`                               | Session persistence control |
| `enableFileCheckpointing`                      | File rewind support         |
| `resume` + `resumeSessionAt` + `forkSession`   | Session resume/fork         |
| `sessionId`                                    | Sync session ID with Agendo |
| SDK hooks (`opts.sdkHooks`)                    | In-process hook callbacks   |
| SDK agents (`opts.sdkAgents`, `opts.sdkAgent`) | Programmatic subagents      |

### NOT Yet Used by Agendo

| SDK Feature                  | Potential Use                         |
| ---------------------------- | ------------------------------------- |
| `listSessions()`             | Session discovery/sync                |
| `getSessionMessages()`       | Conversation replay, history import   |
| `createSdkMcpServer()`       | In-process MCP (avoid stdio overhead) |
| `outputFormat` (JSON schema) | Structured agent output               |
| `promptSuggestions`          | Predicted next prompts in UI          |
| `agentProgressSummaries`     | Richer subagent progress              |
| `maxBudgetUsd`               | Budget enforcement                    |
| `sandbox`                    | Sandboxed execution                   |
| `plugins`                    | Plugin system                         |
| `betas` (1M context)         | Extended context                      |
| `spawnClaudeCodeProcess`     | Remote/container execution            |
| `onElicitation`              | MCP auth flows                        |
| V2 API (`unstable_v2_*`)     | Cleaner session management            |

---

## 14. Opportunities for Agendo

### High Value

1. **`getSessionMessages()`** — Could replace Agendo's log file reading for session replay. Read Claude's canonical JSONL instead of maintaining a parallel log.

2. **`listSessions()`** — Sync Claude sessions with Agendo's session table. Detect sessions started outside Agendo.

3. **`createSdkMcpServer()`** — Run Agendo's MCP tools in-process. Eliminates stdio transport, process management, and the MCP server bundle. Tools would execute as direct function calls.

4. **`outputFormat` (JSON schema)** — Force structured output for specific tasks (e.g., plan generation, code review reports).

5. **`agentProgressSummaries`** — Get AI-generated progress summaries for subagents, show in Team Panel.

### Medium Value

6. **`promptSuggestions`** — Show predicted next prompts in the chat UI.

7. **`sandbox`** — Enable sandboxed execution for untrusted tasks.

8. **`maxBudgetUsd`** — Budget caps per session/task.

9. **Hooks system** — Use in-process hooks for richer integration (e.g., PostToolUse for automatic progress tracking, PermissionRequest for centralized policy).

10. **`spawnClaudeCodeProcess`** — Run agents in containers for isolation.

### Future

11. **V2 Session API** — When stable, cleaner than the AsyncQueue pattern.

12. **Worktree support** — The SDK has `WorktreeCreate`/`WorktreeRemove` hooks; Agendo could use these for parallel branch work.

13. **`betas: ['context-1m-2025-08-07']`** — Enable 1M context for deep codebase analysis.
