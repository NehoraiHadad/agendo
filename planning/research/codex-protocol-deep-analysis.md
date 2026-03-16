# Codex App-Server Protocol Deep Analysis

> Codex CLI v0.104.0, generated 2026-03-16. Source: `codex app-server generate-ts`, rollout JSONL files, Agendo adapter code.

## 1. Protocol Overview

The Codex app-server exposes a **JSON-RPC 2.0 API over NDJSON** (newline-delimited JSON) via stdio. This is the same protocol used by VS Code, JetBrains, Xcode, and the macOS app. The `--listen ws://IP:PORT` flag also supports WebSocket transport.

### Framing

- **NDJSON** (NOT Content-Length/LSP headers)
- Each line is a complete JSON-RPC message
- Client sends requests (with `id`), notifications (no `id`)
- Server sends responses (matching `id`), notifications, and server-initiated requests (with `id`, expecting response)

### Handshake

```
Client → initialize (id:1)
Server ← response (id:1, result: InitializeResponse)
Client → initialized (notification, no id)
```

## 2. Complete Client Request Methods (56 total)

### Thread Management (v2 — preferred)

| Method                 | Params                   | Response                   | Notes                                                             |
| ---------------------- | ------------------------ | -------------------------- | ----------------------------------------------------------------- |
| `thread/start`         | ThreadStartParams        | ThreadStartResponse        | Creates new thread, returns thread + model + config               |
| `thread/resume`        | ThreadResumeParams       | ThreadResumeResponse       | Resumes existing thread, returns **full turn history with items** |
| `thread/fork`          | ThreadForkParams         | ThreadForkResponse         | Forks thread into new thread                                      |
| `thread/read`          | ThreadReadParams         | ThreadReadResponse         | **Reads thread with optional turns/items** (key for history!)     |
| `thread/list`          | ThreadListParams         | ThreadListResponse         | **Lists all threads on disk** with pagination, filtering          |
| `thread/loaded/list`   | ThreadLoadedListParams   | ThreadLoadedListResponse   | Lists thread IDs currently loaded in memory                       |
| `thread/rollback`      | ThreadRollbackParams     | ThreadRollbackResponse     | Drops N turns from end (does NOT revert file changes)             |
| `thread/compact/start` | ThreadCompactStartParams | ThreadCompactStartResponse | Triggers context compaction                                       |
| `thread/archive`       | ThreadArchiveParams      | ThreadArchiveResponse      | Archives a thread                                                 |
| `thread/unarchive`     | ThreadUnarchiveParams    | ThreadUnarchiveResponse    | Unarchives a thread                                               |
| `thread/name/set`      | ThreadSetNameParams      | ThreadSetNameResponse      | Sets thread display name                                          |

### Turn Management (v2)

| Method           | Params              | Response              | Notes                                            |
| ---------------- | ------------------- | --------------------- | ------------------------------------------------ |
| `turn/start`     | TurnStartParams     | TurnStartResponse     | Starts a new turn with user input                |
| `turn/steer`     | TurnSteerParams     | TurnSteerResponse     | Injects guidance mid-turn (requires active turn) |
| `turn/interrupt` | TurnInterruptParams | TurnInterruptResponse | Interrupts active turn                           |

### Configuration

| Method                    | Params                 | Response                       | Notes                                                         |
| ------------------------- | ---------------------- | ------------------------------ | ------------------------------------------------------------- |
| `config/read`             | ConfigReadParams       | ConfigReadResponse             | Reads effective config (with optional cwd for project layers) |
| `config/value/write`      | ConfigValueWriteParams | ConfigWriteResponse            | Writes single config value                                    |
| `config/batchWrite`       | ConfigBatchWriteParams | ConfigWriteResponse            | Batch writes config (used for MCP server injection)           |
| `config/mcpServer/reload` | undefined              | void                           | Reloads MCP server config                                     |
| `configRequirements/read` | undefined              | ConfigRequirementsReadResponse | Reads config requirements                                     |
| `setDefaultModel`         | SetDefaultModelParams  | SetDefaultModelResponse        | Changes model at runtime                                      |

### Skills & Apps

| Method                 | Params                  | Response                  | Notes                                 |
| ---------------------- | ----------------------- | ------------------------- | ------------------------------------- |
| `skills/list`          | SkillsListParams        | SkillsListResponse        | Lists available skills for given cwds |
| `skills/remote/list`   | SkillsRemoteReadParams  | SkillsRemoteReadResponse  | Lists remote skills                   |
| `skills/remote/export` | SkillsRemoteWriteParams | SkillsRemoteWriteResponse | Exports a skill remotely              |
| `skills/config/write`  | SkillsConfigWriteParams | SkillsConfigWriteResponse | Writes skill config                   |
| `app/list`             | AppsListParams          | AppsListResponse          | Lists available apps                  |

### MCP Server Management

| Method                  | Params                    | Response                    | Notes                                            |
| ----------------------- | ------------------------- | --------------------------- | ------------------------------------------------ |
| `mcpServerStatus/list`  | ListMcpServerStatusParams | ListMcpServerStatusResponse | Lists MCP server status (tools, resources, auth) |
| `mcpServer/oauth/login` | McpServerOauthLoginParams | McpServerOauthLoginResponse | Initiates OAuth login for MCP server             |

### Model Discovery

| Method       | Params          | Response          | Notes                                     |
| ------------ | --------------- | ----------------- | ----------------------------------------- |
| `model/list` | ModelListParams | ModelListResponse | Lists available models with rich metadata |

### Code Review

| Method         | Params            | Response            | Notes                                     |
| -------------- | ----------------- | ------------------- | ----------------------------------------- |
| `review/start` | ReviewStartParams | ReviewStartResponse | Starts a code review (inline or detached) |

### Account & Auth

| Method                    | Params                   | Response                     | Notes              |
| ------------------------- | ------------------------ | ---------------------------- | ------------------ |
| `account/login/start`     | LoginAccountParams       | LoginAccountResponse         | Starts login flow  |
| `account/login/cancel`    | CancelLoginAccountParams | CancelLoginAccountResponse   | Cancels login      |
| `account/logout`          | undefined                | LogoutAccountResponse        | Logs out           |
| `account/read`            | GetAccountParams         | GetAccountResponse           | Reads account info |
| `account/rateLimits/read` | undefined                | GetAccountRateLimitsResponse | Reads rate limits  |

### Experimental Features

| Method                     | Params                        | Response                        | Notes                                  |
| -------------------------- | ----------------------------- | ------------------------------- | -------------------------------------- |
| `experimentalFeature/list` | ExperimentalFeatureListParams | ExperimentalFeatureListResponse | Lists feature flags with stage/enabled |

### Utilities

| Method            | Params                | Response                | Notes                                    |
| ----------------- | --------------------- | ----------------------- | ---------------------------------------- |
| `command/exec`    | CommandExecParams     | CommandExecResponse     | Direct command execution (sandboxed)     |
| `feedback/upload` | FeedbackUploadParams  | FeedbackUploadResponse  | Uploads user feedback                    |
| `fuzzyFileSearch` | FuzzyFileSearchParams | FuzzyFileSearchResponse | Fuzzy file search with streaming results |
| `gitDiffToRemote` | GitDiffToRemoteParams | GitDiffToRemoteResponse | Git diff to remote                       |

### Legacy (v1 — still present)

| Method                       | Notes                                |
| ---------------------------- | ------------------------------------ |
| `newConversation`            | Legacy version of thread/start       |
| `resumeConversation`         | Legacy version of thread/resume      |
| `forkConversation`           | Legacy version of thread/fork        |
| `archiveConversation`        | Legacy version of thread/archive     |
| `listConversations`          | Legacy version of thread/list        |
| `getConversationSummary`     | Legacy version of thread/read        |
| `sendUserMessage`            | Legacy version of turn/start         |
| `sendUserTurn`               | Alternative turn start               |
| `interruptConversation`      | Legacy version of turn/interrupt     |
| `addConversationListener`    | Subscribe to conversation events     |
| `removeConversationListener` | Unsubscribe from conversation events |

## 3. Server-Initiated Requests (7 types)

These are sent FROM the server TO the client, requiring a response.

| Method                                  | Params                                | Response                         | Notes                                                |
| --------------------------------------- | ------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| `item/commandExecution/requestApproval` | CommandExecutionRequestApprovalParams | CommandExecutionApprovalResponse | Shell command approval                               |
| `item/fileChange/requestApproval`       | FileChangeRequestApprovalParams       | FileChangeApprovalResponse       | File change approval                                 |
| `item/tool/requestUserInput`            | ToolRequestUserInputParams            | ToolRequestUserInputResponse     | Interactive questions                                |
| `item/tool/call`                        | DynamicToolCallParams                 | DynamicToolCallResponse          | **Dynamic tool invocation** (client-provided tools!) |
| `applyPatchApproval`                    | ApplyPatchApprovalParams              | ApplyPatchApprovalResponse       | Patch approval (legacy)                              |
| `execCommandApproval`                   | ExecCommandApprovalParams             | ExecCommandApprovalResponse      | Command approval (legacy)                            |
| `account/chatgptAuthTokens/refresh`     | ChatgptAuthTokensRefreshParams        | ChatgptAuthTokensRefreshResponse | Auth token refresh                                   |

### Approval Decisions

```typescript
type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: ExecPolicyAmendment } }
  | 'decline'
  | 'cancel';

type FileChangeApprovalDecision = 'accept' | 'decline';
```

### Dynamic Tool Calls (item/tool/call)

This is a **major feature** not yet used by Agendo. The server can call client-provided tools with:

```typescript
{ threadId, turnId, callId, tool: string, arguments: JsonValue }
```

Client responds with:

```typescript
{ contentItems: Array<DynamicToolCallOutputContentItem>, success: boolean }
```

This means Codex can call tools the CLIENT defines, similar to how MCP works but in reverse.

## 4. Server Notifications (37 types)

### Thread & Turn Lifecycle

| Notification                | Params                              | Notes                                                |
| --------------------------- | ----------------------------------- | ---------------------------------------------------- |
| `thread/started`            | ThreadStartedNotification           | Thread created                                       |
| `thread/archived`           | ThreadArchivedNotification          | Thread archived                                      |
| `thread/unarchived`         | ThreadUnarchivedNotification        | Thread unarchived                                    |
| `thread/name/updated`       | ThreadNameUpdatedNotification       | Thread name changed                                  |
| `thread/tokenUsage/updated` | ThreadTokenUsageUpdatedNotification | Token usage update (with model context window!)      |
| `thread/compacted`          | ContextCompactedNotification        | Context compaction complete                          |
| `turn/started`              | TurnStartedNotification             | Turn began                                           |
| `turn/completed`            | TurnCompletedNotification           | Turn finished (status: completed/interrupted/failed) |
| `turn/diff/updated`         | TurnDiffUpdatedNotification         | **Aggregated diff across all file changes in turn**  |
| `turn/plan/updated`         | TurnPlanUpdatedNotification         | Plan steps updated (with status per step)            |

### Item Lifecycle

| Notification                | Params                               | Notes                                                                      |
| --------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `item/started`              | ItemStartedNotification              | Item began (agentMessage, commandExecution, fileChange, mcpToolCall, etc.) |
| `item/completed`            | ItemCompletedNotification            | Item finished                                                              |
| `rawResponseItem/completed` | RawResponseItemCompletedNotification | Raw API response items (when experimentalRawEvents=true)                   |

### Streaming Deltas

| Notification                                | Params                                  | Notes                              |
| ------------------------------------------- | --------------------------------------- | ---------------------------------- |
| `item/agentMessage/delta`                   | AgentMessageDeltaNotification           | Streaming text                     |
| `item/plan/delta`                           | PlanDeltaNotification                   | Streaming plan text                |
| `item/commandExecution/outputDelta`         | CommandExecutionOutputDeltaNotification | Streaming command output           |
| `item/commandExecution/terminalInteraction` | TerminalInteractionNotification         | **Terminal stdin sent to process** |
| `item/fileChange/outputDelta`               | FileChangeOutputDeltaNotification       | Streaming file change output       |
| `item/mcpToolCall/progress`                 | McpToolCallProgressNotification         | MCP tool call progress             |
| `item/reasoning/summaryTextDelta`           | ReasoningSummaryTextDeltaNotification   | Reasoning summary streaming        |
| `item/reasoning/summaryPartAdded`           | ReasoningSummaryPartAddedNotification   | New reasoning summary section      |
| `item/reasoning/textDelta`                  | ReasoningTextDeltaNotification          | Raw reasoning text streaming       |

### Configuration & Status

| Notification        | Params                        | Notes                           |
| ------------------- | ----------------------------- | ------------------------------- |
| `sessionConfigured` | SessionConfiguredNotification | Session config confirmed        |
| `model/rerouted`    | ModelReroutedNotification     | Model rerouted (e.g., fallback) |
| `error`             | ErrorNotification             | Error occurred                  |
| `deprecationNotice` | DeprecationNoticeNotification | Deprecation warning             |
| `configWarning`     | ConfigWarningNotification     | Config warning                  |

### Account

| Notification                 | Params                               | Notes                |
| ---------------------------- | ------------------------------------ | -------------------- |
| `account/updated`            | AccountUpdatedNotification           | Account info changed |
| `account/rateLimits/updated` | AccountRateLimitsUpdatedNotification | Rate limits changed  |
| `account/login/completed`    | AccountLoginCompletedNotification    | Login flow completed |
| `authStatusChange`           | AuthStatusChangeNotification         | Auth status changed  |

### MCP & Search

| Notification                       | Params                                      | Notes                    |
| ---------------------------------- | ------------------------------------------- | ------------------------ |
| `mcpServer/oauthLogin/completed`   | McpServerOauthLoginCompletedNotification    | MCP OAuth done           |
| `app/list/updated`                 | AppListUpdatedNotification                  | App list changed         |
| `fuzzyFileSearch/sessionUpdated`   | FuzzyFileSearchSessionUpdatedNotification   | Search results streaming |
| `fuzzyFileSearch/sessionCompleted` | FuzzyFileSearchSessionCompletedNotification | Search complete          |

## 5. ThreadItem Types (12 types)

```typescript
type ThreadItem =
  | { type: 'userMessage'; id; content: UserInput[] }
  | { type: 'agentMessage'; id; text }
  | { type: 'plan'; id; text }
  | { type: 'reasoning'; id; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id;
      command;
      cwd;
      processId;
      status;
      commandActions;
      aggregatedOutput;
      exitCode;
      durationMs;
    }
  | { type: 'fileChange'; id; changes: FileUpdateChange[]; status }
  | { type: 'mcpToolCall'; id; server; tool; status; arguments; result; error; durationMs }
  | {
      type: 'collabAgentToolCall';
      id;
      tool;
      status;
      senderThreadId;
      receiverThreadIds;
      prompt;
      agentsStates;
    }
  | { type: 'webSearch'; id; query; action }
  | { type: 'imageView'; id; path }
  | { type: 'enteredReviewMode'; id; review }
  | { type: 'exitedReviewMode'; id; review }
  | { type: 'contextCompaction'; id };
```

### CollabAgentToolCall (Multi-Agent)

This is a **major feature**: Codex supports native multi-agent collaboration.

```typescript
type CollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent';
type CollabAgentStatus =
  | 'pendingInit'
  | 'running'
  | 'completed'
  | 'errored'
  | 'shutdown'
  | 'notFound';
type CollabAgentState = { status: CollabAgentStatus; message: string | null };
```

The `collabAgentToolCall` item tracks agent-to-agent interactions including spawn, input, resume, wait, and close.

## 6. Thread History: How It Works

### thread/read — Get Full Conversation History

```typescript
// Request
{ method: "thread/read", params: { threadId: "...", includeTurns: true } }

// Response
{
  thread: {
    id: string,
    preview: string,        // First user message
    modelProvider: "openai",
    createdAt: number,      // Unix seconds
    updatedAt: number,
    path: string | null,    // Path on disk (UNSTABLE)
    cwd: string,
    cliVersion: string,
    source: SessionSource,
    gitInfo: GitInfo | null,
    turns: Turn[]           // Only populated when includeTurns=true
  }
}
```

Each `Turn` contains:

```typescript
{
  id: string,
  items: ThreadItem[],  // Only populated on resume/fork/read
  status: "completed" | "interrupted" | "failed" | "inProgress",
  error: TurnError | null
}
```

### thread/resume — Returns Full History + Items

When resuming a thread, the response includes the complete thread with all turns AND their items. This is confirmed in the type comments:

> "Only populated on `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read` (when `includeTurns` is true) responses."

### thread/list — Paginated Thread Listing

```typescript
// Supports filtering by:
{
  cursor: string | null,          // Pagination
  limit: number | null,           // Page size
  sortKey: "created_at" | "updated_at",
  modelProviders: string[],       // Filter by provider
  sourceKinds: ThreadSourceKind[],// Filter by source (cli, vscode, appServer, subAgent...)
  archived: boolean,              // Archived only
  cwd: string                     // Filter by working directory
}
```

### Key Finding: Agendo CAN Get Full Conversation History

**`thread/read` with `includeTurns: true` returns the complete conversation**. This means Agendo does NOT need to maintain its own log of the conversation -- it can reconstruct it from Codex at any time.

However, the current adapter does NOT use `thread/read`. Adding a `getHistory()` method would allow on-demand history retrieval.

## 7. Rollout JSONL Files (On-Disk Format)

Threads are stored at `~/.codex/sessions/YYYY/MM/DD/rollout-{timestamp}-{threadId}.jsonl`.

Each line is a JSON object with:

```typescript
{
  timestamp: string,            // ISO 8601
  type: "session_meta" | "response_item" | "event_msg" | "turn_context",
  payload: object               // Type-specific
}
```

### Record Types

1. **`session_meta`** — First line, contains: id, cwd, originator, cli_version, source, model_provider, base_instructions, git info
2. **`response_item`** — Raw API response items (developer messages, user messages). Content format matches OpenAI Responses API.
3. **`event_msg`** — EventMsg union type (same as the notification events, but persisted). Includes: task_started, task_complete, agent_message, user_message, exec_command_begin/end, mcp_tool_call_begin/end, etc.
4. **`turn_context`** — Per-turn config snapshot: turn_id, cwd, approval_policy, sandbox_policy, model, personality, collaboration_mode, effort, summary, user_instructions, developer_instructions, truncation_policy.

### persistExtendedHistory Flag

When `persistExtendedHistory: true` is set in thread/start or thread/resume, additional event_msg variants are written to the rollout file, enabling richer reconstruction on resume/fork/read. Agendo currently sets this to `false` — enabling it would give richer replay data.

## 8. Token Usage (Rich Breakdown)

```typescript
type ThreadTokenUsage = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null; // Actual model context window!
};

type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};
```

The `thread/tokenUsage/updated` notification includes `modelContextWindow`, which is the actual context limit. Agendo currently hardcodes 200K -- it should use the reported value.

## 9. Collaboration Mode System

```typescript
type CollaborationMode = {
  mode: ModeKind; // "plan" | "default"
  settings: Settings;
};

type Settings = {
  model: string;
  reasoning_effort: ReasoningEffort | null;
  developer_instructions: string | null;
};
```

Collaboration modes bundle model + reasoning effort + instructions into a preset. TurnStartParams accepts an optional `collaborationMode` that overrides individual settings.

## 10. turn/diff/updated — Aggregated Diffs

```typescript
type TurnDiffUpdatedNotification = {
  threadId: string;
  turnId: string;
  diff: string; // Full unified diff of all file changes in the turn
};
```

This is emitted as file changes happen during a turn. It provides a live, aggregated diff of ALL changes made so far in the current turn. **Agendo does NOT currently handle this notification** -- it would be valuable for showing real-time diffs in the UI.

## 11. What Agendo Currently Handles vs. Misses

### Currently Handled (in codex-app-server-adapter.ts)

- `thread/started` (partially -- model from response, not notification)
- `turn/started`, `turn/completed`
- `item/started`, `item/completed`
- `item/agentMessage/delta`
- `item/reasoning/summaryTextDelta`
- `item/commandExecution/outputDelta`
- `item/plan/delta`
- `turn/planUpdated`
- `thread/tokenUsage/updated` (token tracking + auto-compaction)
- `sessionConfigured`
- `model/rerouted`
- `error`
- Approval handling: commandExecution, fileChange, tool/requestUserInput
- MCP health check via `mcpServerStatus/list`
- Skills discovery via `skills/list` + filesystem
- Model switching via `setDefaultModel`
- Context compaction via `thread/compact/start`
- Turn steering via `turn/steer`
- Thread rollback via `thread/rollback`

### NOT Handled (gaps/opportunities)

| Feature                       | Method/Notification                                     | Value for Agendo                                           |
| ----------------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| **Thread history retrieval**  | `thread/read` (includeTurns: true)                      | Reconstruct full conversation without local log            |
| **Thread listing**            | `thread/list`                                           | Browse all Codex threads, import into Agendo               |
| **Turn diffs**                | `turn/diff/updated`                                     | Real-time unified diff display                             |
| **Dynamic tool calls**        | `item/tool/call` (server request)                       | Client-defined tools -- Agendo could inject tools directly |
| **File change output deltas** | `item/fileChange/outputDelta`                           | Streaming file change details                              |
| **MCP tool progress**         | `item/mcpToolCall/progress`                             | MCP call progress tracking                                 |
| **Terminal interaction**      | `item/commandExecution/terminalInteraction`             | Shows stdin sent to running processes                      |
| **Thread naming**             | `thread/name/set`, `thread/name/updated`                | Auto-naming threads                                        |
| **Fuzzy file search**         | `fuzzyFileSearch` + streaming notifications             | Agent file discovery                                       |
| **Code review**               | `review/start`                                          | Built-in code review capability                            |
| **Git diff to remote**        | `gitDiffToRemote`                                       | Compare local to remote                                    |
| **Direct command exec**       | `command/exec`                                          | Sandboxed one-off commands                                 |
| **Collab agent tools**        | `collabAgentToolCall` items                             | Native multi-agent tracking                                |
| **Extended history**          | `persistExtendedHistory: true`                          | Richer thread replay data                                  |
| **Model context window**      | `threadTokenUsage.modelContextWindow`                   | Accurate context tracking instead of hardcoded 200K        |
| **Rate limits**               | `account/rateLimits/read`, `account/rateLimits/updated` | Rate limit awareness                                       |
| **Feature flags**             | `experimentalFeature/list`                              | Discover available experimental features                   |
| **WebSearch items**           | `webSearch` ThreadItem type                             | Track web search actions                                   |
| **ImageView items**           | `imageView` ThreadItem type                             | Track image viewing                                        |
| **Review mode**               | `enteredReviewMode`/`exitedReviewMode`                  | Track review mode                                          |
| **Undo**                      | `UndoStartedEvent`/`UndoCompletedEvent`                 | Track undo operations                                      |

## 12. Event Persistence (EventMsg — 63 types)

The `EventMsg` union type represents ALL events that can be persisted to rollout files. This includes everything the TUI displays:

### Text & Reasoning (8 types)

- `agent_message`, `agent_message_delta`, `agent_message_content_delta`
- `agent_reasoning`, `agent_reasoning_delta`
- `agent_reasoning_raw_content`, `agent_reasoning_raw_content_delta`
- `agent_reasoning_section_break`

### Tool Execution (12 types)

- `exec_command_begin`, `exec_command_output_delta`, `exec_command_end`, `terminal_interaction`
- `patch_apply_begin`, `patch_apply_end`
- `mcp_tool_call_begin`, `mcp_tool_call_end`
- `web_search_begin`, `web_search_end`
- `view_image_tool_call`
- `exec_approval_request`

### Multi-Agent Collaboration (8 types)

- `collab_agent_spawn_begin`, `collab_agent_spawn_end`
- `collab_agent_interaction_begin`, `collab_agent_interaction_end`
- `collab_waiting_begin`, `collab_waiting_end`
- `collab_close_begin`, `collab_close_end`
- `collab_resume_begin`, `collab_resume_end`

### Turn & Thread (10 types)

- `task_started` (turn started), `task_complete` (turn complete), `turn_aborted`
- `turn_diff`
- `plan_update`, `plan_delta`
- `item_started`, `item_completed`
- `context_compacted`, `thread_rolled_back`

### Control & Status (8 types)

- `session_configured`, `model_reroute`, `thread_name_updated`
- `error`, `warning`, `stream_error`, `deprecation_notice`
- `shutdown_complete`

### Interactive (5 types)

- `exec_approval_request`, `apply_patch_approval_request`
- `request_user_input`, `dynamic_tool_call_request`, `elicitation_request`

### Skills & MCP (7 types)

- `mcp_startup_update`, `mcp_startup_complete`, `mcp_list_tools_response`
- `list_skills_response`, `list_remote_skills_response`, `remote_skill_downloaded`, `skills_update_available`
- `list_custom_prompts_response`

### Other (5 types)

- `user_message`, `token_count`, `background_event`
- `undo_started`, `undo_completed`
- `raw_response_item` (when experimentalRawEvents=true)
- `entered_review_mode`, `exited_review_mode`
- `get_history_entry_response`

## 13. @openai/codex-sdk

The `@openai/codex-sdk` package is NOT installed in the Agendo project. It wraps the app-server protocol at a higher level:

```typescript
import Codex from '@openai/codex-sdk';
const codex = new Codex();
const thread = await codex.startThread({ model: 'o4-mini' });
const result = await thread.run('Fix the bug');
// or streaming:
const stream = await thread.runStreamed('Fix the bug');
for await (const event of stream) { ... }
```

The SDK is simpler but **does not expose**:

- Approval handling (auto-accepts everything)
- MCP configuration
- Fine-grained turn control (steer, interrupt)
- Thread management (fork, rollback, compact)
- Configuration overrides

**Verdict**: The raw JSON-RPC approach (current Agendo implementation) is correct for full control. The SDK is only useful for fire-and-forget scenarios.

## 14. Key Recommendations for Agendo

### High-Priority Gaps

1. **Add `thread/read` support** — Enable on-demand history retrieval. Add `getHistory()` method to the adapter that calls `thread/read` with `includeTurns: true`.

2. **Handle `turn/diff/updated`** — This provides a live unified diff during turns. Map to a new `agent:diff-update` event for the UI to show real-time diffs.

3. **Use `modelContextWindow` from token usage** — Replace the hardcoded 200K limit with the actual value from `threadTokenUsage.modelContextWindow`.

4. **Enable `persistExtendedHistory`** — Set to `true` in thread/start and thread/resume for richer replay data.

5. **Handle `item/fileChange/outputDelta`** — Currently unhandled; would show streaming file change details.

### Medium-Priority

6. **Explore `item/tool/call`** — Dynamic tool calls let Agendo inject client-defined tools directly into Codex sessions without MCP. Could replace MCP for simple use cases.

7. **Handle `item/commandExecution/terminalInteraction`** — Shows stdin sent to running processes; useful for debugging.

8. **Handle `item/mcpToolCall/progress`** — MCP tool call progress tracking.

9. **Add `thread/list` support** — Allow browsing/importing Codex threads not started by Agendo.

10. **Thread naming** — Use `thread/name/set` to name threads based on task titles.

### Low-Priority / Future

11. **Multi-agent collaboration events** — Handle `collab_*` events when Codex's multi-agent feature matures.

12. **Code review** — `review/start` could be triggered from Agendo's UI.

13. **Rate limit awareness** — Track `account/rateLimits/updated` for smarter scheduling.

14. **Feature flag discovery** — `experimentalFeature/list` to know what's available.

## 15. Comparison with Current Agendo Adapter

The current `CodexAppServerAdapter` is well-implemented for the core use case. It correctly:

- Manages the NDJSON transport layer
- Handles the initialize → thread/start → turn/start lifecycle
- Maps all major notifications to AgendoEventPayloads
- Handles all three approval types (command, fileChange, userInput)
- Supports resume, steer, rollback, compaction
- Polls MCP health

The main gaps are in history retrieval (thread/read), turn diffs, and dynamic tool calls. These are enhancement opportunities, not bugs.

## Appendix A: UserInput Types

```typescript
type UserInput =
  | { type: 'text'; text: string; text_elements: TextElement[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };
```

Skills and mentions can be included in user input, which means Agendo could invoke Codex skills directly.

## Appendix B: Rollout File Path Convention

```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{YYYY-MM-DD}T{HH-mm-ss}-{threadId}.jsonl
```

Thread IDs are UUIDv7 (time-sortable).
