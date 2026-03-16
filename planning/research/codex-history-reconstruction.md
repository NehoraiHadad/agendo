# Codex History Reconstruction via `thread/read`

> Research doc for replacing log-file-based replay with CLI-native history retrieval.
> Codex CLI v0.104.0, types generated via `codex app-server generate-ts --experimental`.
> Date: 2026-03-16.

---

## 1. `thread/read` JSON-RPC Request/Response Format

### Request

```typescript
// Method: "thread/read"
type ThreadReadParams = {
  threadId: string;
  /** When true, include turns and their items from rollout history. */
  includeTurns: boolean;
};
```

Minimal example:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "thread/read",
  "params": {
    "threadId": "019cb7e7-356c-78c3-824c-c04c83e39511",
    "includeTurns": true
  }
}
```

### Response

```typescript
type ThreadReadResponse = {
  thread: Thread;
};

type Thread = {
  id: string;
  /** Usually the first user message, used as preview text. */
  preview: string;
  modelProvider: string; // e.g. "openai"
  createdAt: number; // Unix seconds
  updatedAt: number; // Unix seconds
  path: string | null; // [UNSTABLE] rollout JSONL path on disk
  cwd: string; // Working directory
  cliVersion: string; // e.g. "0.104.0"
  source: SessionSource; // "cli" | "vscode" | "exec" | "appServer" | { subAgent: ... } | "unknown"
  gitInfo: GitInfo | null; // { sha, branch, originUrl } — all nullable
  /**
   * Only populated on thread/resume, thread/rollback, thread/fork,
   * and thread/read (when includeTurns is true).
   * Empty array for all other responses.
   */
  turns: Turn[];
};
```

### Turn Structure

```typescript
type Turn = {
  id: string;
  /**
   * IMPORTANT: The generated TS doc says items are "Only populated on
   * thread/resume or thread/fork". However, the Thread.turns doc
   * explicitly includes thread/read (when includeTurns=true).
   * The Turn doc appears to be stale — items ARE populated on thread/read.
   */
  items: ThreadItem[];
  status: TurnStatus; // "completed" | "interrupted" | "failed" | "inProgress"
  /** Only populated when status is "failed". */
  error: TurnError | null;
};

type TurnError = {
  message: string;
  codexErrorInfo: CodexErrorInfo | null;
  additionalDetails: string | null;
};
```

---

## 2. ThreadItem Types and Their Fields

There are **13 ThreadItem types** (discriminated union on `type`):

### 2.1 `userMessage`

```typescript
{ type: "userMessage", id: string, content: UserInput[] }
// UserInput = { type: "text", text, text_elements }
//           | { type: "image", url }
//           | { type: "localImage", path }
//           | { type: "skill", name, path }
//           | { type: "mention", name, path }
```

### 2.2 `agentMessage`

```typescript
{ type: "agentMessage", id: string, text: string }
```

### 2.3 `plan`

```typescript
{ type: "plan", id: string, text: string }
```

### 2.4 `reasoning`

```typescript
{
  type: "reasoning", id: string,
  summary: string[],   // Concise summaries (for display)
  content: string[]     // Full reasoning content
}
```

### 2.5 `commandExecution`

```typescript
{
  type: "commandExecution", id: string,
  command: string,
  cwd: string,
  processId: string | null,
  status: "inProgress" | "completed" | "failed" | "declined",
  commandActions: CommandAction[],  // Parsed command structure
  aggregatedOutput: string | null,
  exitCode: number | null,
  durationMs: number | null
}
// CommandAction = { type: "read", command, name, path }
//               | { type: "listFiles", command, path }
//               | { type: "search", command, query, path }
//               | { type: "unknown", command }
```

### 2.6 `fileChange`

```typescript
{
  type: "fileChange", id: string,
  changes: FileUpdateChange[],
  status: "inProgress" | "completed" | "failed" | "declined"
}
// FileUpdateChange = { path, kind: PatchChangeKind, diff: string }
// PatchChangeKind = { type: "add" } | { type: "delete" } | { type: "update", move_path: string | null }
```

### 2.7 `mcpToolCall`

```typescript
{
  type: "mcpToolCall", id: string,
  server: string,
  tool: string,
  status: "inProgress" | "completed" | "failed",
  arguments: JsonValue,
  result: { content: JsonValue[], structuredContent: JsonValue | null } | null,
  error: { message: string } | null,
  durationMs: number | null
}
```

### 2.8 `collabAgentToolCall`

```typescript
{
  type: "collabAgentToolCall", id: string,
  tool: "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent",
  status: CollabAgentToolCallStatus,
  senderThreadId: string,
  receiverThreadIds: string[],
  prompt: string | null,
  agentsStates: Record<string, CollabAgentState>
}
```

### 2.9 `webSearch`

```typescript
{
  type: "webSearch", id: string,
  query: string,
  action: WebSearchAction | null
}
// WebSearchAction = { type: "search", query, queries }
//                 | { type: "openPage", url }
//                 | { type: "findInPage", url, pattern }
//                 | { type: "other" }
```

### 2.10 `imageView`

```typescript
{ type: "imageView", id: string, path: string }
```

### 2.11 `enteredReviewMode` / 2.12 `exitedReviewMode`

```typescript
{ type: "enteredReviewMode", id: string, review: string }
{ type: "exitedReviewMode", id: string, review: string }
```

### 2.13 `contextCompaction`

```typescript
{ type: "contextCompaction", id: string }
```

---

## 3. Mapping Table: ThreadItem to AgendoEventPayload

| ThreadItem type                | AgendoEventPayload type                | Mapping logic                                                             | Notes                                                         |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `userMessage`                  | `user:message`                         | `text = content.filter(c => c.type === 'text').map(c => c.text).join('')` | Also check for `localImage`/`image` types -> `hasImage: true` |
| `agentMessage`                 | `agent:text`                           | `text = item.text`                                                        | Direct map                                                    |
| `plan`                         | `agent:text`                           | `text = item.text` (current behavior)                                     | Could map to `agent:plan` entries if structured               |
| `reasoning`                    | `agent:thinking`                       | `text = item.summary.join('\n') \|\| item.content.join('\n')`             | Prefer summary for display                                    |
| `commandExecution` (started)   | `agent:tool-start`                     | `toolName='Bash', toolUseId=item.id, input={command, cwd}`                |                                                               |
| `commandExecution` (completed) | `agent:tool-end`                       | `toolUseId=item.id, content=aggregatedOutput, durationMs=item.durationMs` | Include exitCode in content if non-zero                       |
| `fileChange` (started)         | `agent:tool-start`                     | `toolName='FileChange', toolUseId=item.id, input={changes}`               |                                                               |
| `fileChange` (completed)       | `agent:tool-end`                       | `toolUseId=item.id, content=changes.map(c => kind+path).join('\n')`       | `diff` field available for richer display                     |
| `mcpToolCall` (started)        | `agent:tool-start`                     | `toolName=item.tool, toolUseId=item.id, input={server, tool, arguments}`  |                                                               |
| `mcpToolCall` (completed)      | `agent:tool-end`                       | `toolUseId=item.id, content=result?.output \|\| error?.message`           | `durationMs` available                                        |
| `collabAgentToolCall`          | `agent:tool-start` + `agent:tool-end`  | `toolName=item.tool` (spawnAgent, sendInput, etc.)                        | New: not currently mapped by Agendo                           |
| `webSearch`                    | `agent:tool-start` + `agent:tool-end`  | `toolName='WebSearch', input={query, action}`                             | New: not currently mapped                                     |
| `imageView`                    | `agent:tool-start` + `agent:tool-end`  | `toolName='ImageView', input={path}`                                      | New: not currently mapped                                     |
| `enteredReviewMode`            | `system:info`                          | `message = "Entered review mode"`                                         |                                                               |
| `exitedReviewMode`             | `system:info`                          | `message = "Exited review mode"`                                          |                                                               |
| `contextCompaction`            | `system:compact-start` + `system:info` | Signals compaction occurred                                               |                                                               |

### What CANNOT be reconstructed from `thread/read`

| AgendoEvent type                     | Why missing                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `agent:text-delta`                   | Streaming deltas are ephemeral; only final text persisted                   |
| `agent:thinking-delta`               | Same: only final reasoning persisted                                        |
| `agent:result` (costUsd, modelUsage) | Codex provides NO cost data in any API                                      |
| `agent:activity`                     | Synthesized by Agendo from adapter signals                                  |
| `agent:tool-approval`                | Approval requests are server-initiated RPCs, not stored in thread           |
| `agent:usage`                        | Context window metrics not in thread items                                  |
| `session:init`                       | Partially: model/cwd from Thread metadata, but not mcpServers/slashCommands |
| `session:state`                      | Agendo-only concept                                                         |
| `session:mode-change`                | Agendo-only concept                                                         |
| `system:mcp-status`                  | Agendo-only health checks                                                   |
| `system:rate-limit`                  | Not exposed by Codex                                                        |
| `team:*`                             | Agendo-only team coordination                                               |
| `subagent:*`                         | Agendo-only subagent tracking                                               |

### What CAN be reconstructed that Agendo currently lacks

| Data point                        | Source                 | Value                                               |
| --------------------------------- | ---------------------- | --------------------------------------------------- |
| `commandExecution.durationMs`     | ThreadItem field       | Tool call timing (currently null in `agent:result`) |
| `mcpToolCall.durationMs`          | ThreadItem field       | MCP tool call timing                                |
| `fileChange.diff`                 | FileUpdateChange field | Actual unified diff per file change                 |
| `commandExecution.commandActions` | ThreadItem field       | Parsed command structure (read/search/listFiles)    |
| `webSearch` items                 | ThreadItem type        | Web search queries and results                      |
| `collabAgentToolCall` items       | ThreadItem type        | Multi-agent collaboration tracking                  |

---

## 4. `thread/read` vs JSONL File Fallback

### `thread/read` (via running app-server)

**Pros:**

- Structured, typed response with Turn/ThreadItem hierarchy
- Items are already normalized (camelCase, typed unions)
- Thread metadata included (cwd, model, git info, timestamps)
- Works with compacted threads (Codex handles reconstruction internally)
- No file path guessing needed

**Cons:**

- **Requires a running `codex app-server` process.** This is the critical limitation.
- The app-server must load the thread into memory to read it.
- No cost or token usage data in the response.

### JSONL Rollout Files (on-disk fallback)

**Location:** `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{threadId}.jsonl`

**Format:** Each line is one of four record types:

1. `session_meta` — first line, contains id, cwd, cli_version, source, model_provider, base_instructions, git info
2. `response_item` — raw OpenAI Responses API items (messages, function calls, outputs, custom tool calls, reasoning)
3. `event_msg` — 63+ event types (agent_message, exec_command_begin/end, mcp_tool_call_begin/end, token_count, etc.)
4. `turn_context` — per-turn config snapshot (turn_id, cwd, model, effort, approval_policy, etc.)

**Observed distribution in a real 2373-line session:**

- `event_msg`: 1065 (45%) — dominated by `token_count` (663), `agent_reasoning` (308)
- `response_item`: 974 (41%) — reasoning (308), function_call/output (512), messages (94)
- `turn_context`: 333 (14%)
- `session_meta`: 1

**Pros:**

- Available offline (no running process needed)
- Contains richer data: token counts, raw API messages, turn-level config snapshots
- The existing `codex-reader.ts` already parses this format
- `persistExtendedHistory: true` (currently `false` in Agendo) would add even more event data

**Cons:**

- Different format from `thread/read` (OpenAI API items vs ThreadItems)
- File discovery requires directory traversal (YYYY/MM/DD structure)
- No structured Turn/ThreadItem hierarchy — must be reconstructed
- `response_item` contains raw API messages (`function_call`, `custom_tool_call`) not the normalized ThreadItem types
- Context re-injection: on resume, Codex replays all developer/user messages at the start of each turn, creating duplicates that must be filtered

### Recommendation: Dual Strategy

1. **Primary: `thread/read`** when the app-server is running (which it always is during an active Agendo session). Use for:
   - Live history reconstruction on page refresh (SSE reconnect)
   - Session viewer "replay" mode
   - On-demand history fetch for the session detail page

2. **Fallback: JSONL file parsing** (existing `codex-reader.ts`) when:
   - The session has ended and the app-server is no longer running
   - Historical session browsing (no active worker process)
   - The `thread/read` call fails or times out

3. **Enable `persistExtendedHistory: true`** in `thread/start` and `thread/resume` to ensure the rollout JSONL contains the full event stream for richer offline reconstruction.

---

## 5. `thread/list` for Session Discovery

### Request

```typescript
type ThreadListParams = {
  cursor?: string | null; // Opaque pagination cursor from previous call
  limit?: number | null; // Page size (server default if omitted)
  sortKey?: 'created_at' | 'updated_at' | null;
  modelProviders?: string[] | null; // Filter by provider (e.g. ["openai"])
  sourceKinds?: ThreadSourceKind[] | null;
  // ThreadSourceKind = "cli" | "vscode" | "exec" | "appServer" | "subAgent"
  //                  | "subAgentReview" | "subAgentCompact" | "subAgentThreadSpawn"
  //                  | "subAgentOther" | "unknown"
  archived?: boolean | null; // true = archived only, false/null = non-archived
  cwd?: string | null; // Exact cwd match filter
};
```

### Response

```typescript
type ThreadListResponse = {
  data: Thread[]; // Thread objects (turns will be empty)
  nextCursor: string | null; // null = no more pages
};
```

### Key Points

- **Pagination**: cursor-based, forward-only. Call again with `nextCursor` to get next page.
- **Filter by project**: use `cwd` parameter to list only threads for a specific working directory.
- **Filter by source**: Agendo sessions use `sourceKinds: ["appServer"]`; filter out CLI/VS Code sessions if desired.
- **Thread metadata only**: `turns` array is empty in list results (use `thread/read` to get items).
- **Same running-process requirement**: needs an active `codex app-server` instance.

### Use Cases for Agendo

1. **Import external Codex sessions**: show threads not started by Agendo, allow linking to tasks.
2. **Session validation**: cross-check Agendo's session table against actual Codex threads.
3. **Sub-agent discovery**: filter by `sourceKinds: ["subAgent"]` to find agent-spawned sub-threads.

---

## 6. Edge Cases and Limitations

### 6.1 Compacted Threads

When `thread/compact/start` is called, Codex summarizes older context and drops individual items. After compaction:

- `thread/read` returns a `contextCompaction` item in place of the compacted region.
- Items before the compaction boundary are **lost** from the thread/read response.
- The rollout JSONL still contains the original items (compaction only affects the in-memory context window, not the persisted history).

**Implication**: For full history reconstruction after compaction, use the JSONL fallback. `thread/read` will only show post-compaction items plus the compaction marker.

### 6.2 Forked Threads

`thread/fork` creates a new thread that shares history up to the fork point.

- The forked thread gets a new `threadId` but the `thread/read` response includes ALL items from before the fork (they are copied, not referenced).
- The parent thread is unaffected.
- `thread/read` on the fork returns the complete history (parent + fork).

**Implication**: No special handling needed. Forked threads are self-contained.

### 6.3 Rolled-Back Turns

`thread/rollback` removes the last N turns from the thread.

- Rolled-back turns are removed from the in-memory thread.
- `thread/read` after rollback does NOT include the rolled-back turns.
- The rollout JSONL contains a `thread_rolled_back` event but the original turn data is still in the file.

**Implication**: If Agendo needs to show rolled-back turns (e.g., greyed out), it must parse the JSONL. `thread/read` only shows the current thread state.

### 6.4 Large Threads (100+ turns)

- `thread/read` returns the full thread in a single response. There is no pagination for turns/items within a thread.
- For a thread with 100+ turns and hundreds of items, the response could be several MB of JSON.
- The NDJSON transport handles this as a single line (one JSON-RPC response object).

**Mitigation strategies**:

- Set a generous timeout (30+ seconds) for `thread/read` calls.
- Consider caching the response and only re-fetching on demand.
- The `thread/list` endpoint only returns metadata (no items), so it stays fast regardless of thread size.

### 6.5 Running Process Requirement

**This is the most significant limitation.** `thread/read` and `thread/list` are JSON-RPC methods on the `codex app-server` process. They require:

1. A running `codex app-server` process.
2. The process must have been initialized (`initialize` + `initialized` handshake).

When Agendo's session is active, the app-server is already running (spawned by the adapter). But when the session is idle or ended:

- The app-server process has exited.
- `thread/read` is unavailable.
- Must fall back to JSONL parsing.

**Possible solutions**:

1. **Keep a persistent app-server** for read-only operations (separate from session processes). Cost: one persistent process per agent type.
2. **Spawn on demand**: start `codex app-server`, initialize, call `thread/read`, then exit. Cost: ~1-2 second startup latency.
3. **Prefer JSONL for ended sessions**: only use `thread/read` for active sessions where the process is already running.

Option 3 is the most pragmatic. The adapter already holds a reference to the transport; adding a `readThread()` method is straightforward.

### 6.6 `persistExtendedHistory` Flag

Currently Agendo sets `persistExtendedHistory: false` in both `thread/start` and `thread/resume`. This means the rollout JSONL contains only the basic record types (`session_meta`, `response_item`, `turn_context`, and a subset of `event_msg`).

Setting it to `true` would persist additional `event_msg` variants (agent messages, exec command begin/end with timing, MCP tool call begin/end, etc.), enabling richer JSONL reconstruction.

**Recommendation**: Enable `persistExtendedHistory: true`. This costs slightly more disk I/O but ensures the JSONL fallback is as rich as possible.

### 6.7 Stale Doc Discrepancy in Turn.items

The generated `Turn` type says items are "Only populated on a `thread/resume` or `thread/fork` response." But the `Thread.turns` doc says they ARE populated on `thread/read` when `includeTurns: true`. This appears to be a stale doc on the Turn type -- the Thread-level doc is authoritative. Verified by the fact that `thread/read` explicitly accepts `includeTurns: boolean` and the Thread type lists `thread/read` as a populator.

### 6.8 Missing Data: No Cost or Token Usage

`thread/read` returns thread items but NOT:

- Per-turn token usage (available via `thread/tokenUsage/updated` notification, but not persisted in thread/read)
- Cost estimates (Codex does not expose cost data anywhere)
- Per-turn model information (available in `turn_context` JSONL records, but not in `Turn` type)

The rollout JSONL has richer data: `token_count` event_msg records contain per-API-call token breakdowns. `turn_context` records contain the model used for each turn.

---

## 7. Implementation Sketch

### Adding `readThread()` to the adapter

```typescript
// In CodexAppServerAdapter:
async readThread(threadId?: string): Promise<ThreadReadResponse | null> {
  const id = threadId ?? this.threadId;
  if (!id || !this.alive) return null;

  return this.transport.call('thread/read', {
    threadId: id,
    includeTurns: true,
  }, 30_000) as Promise<ThreadReadResponse>;
}
```

### Mapping function: Thread -> AgendoEventPayload[]

```typescript
function threadToEvents(thread: Thread): AgendoEventPayload[] {
  const events: AgendoEventPayload[] = [];

  // session:init from thread metadata
  events.push({
    type: 'session:init',
    sessionRef: thread.id,
    slashCommands: [],
    mcpServers: [],
    model: '', // Not available in Thread; would need separate tracking
    cwd: thread.cwd,
  });

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      events.push(...threadItemToEvents(item));
    }
    // Emit agent:result at end of each completed turn
    if (turn.status === 'completed' || turn.status === 'failed') {
      events.push({
        type: 'agent:result',
        costUsd: null,
        turns: 1,
        durationMs: null,
        isError: turn.status === 'failed',
        errors: turn.error ? [turn.error.message] : undefined,
      });
    }
  }

  return events;
}
```

The `threadItemToEvents()` function would reuse the existing `normalizeThreadItem()` + `mapAppServerEventToPayloads()` pipeline from `codex-app-server-event-mapper.ts`, since `thread/read` returns the same ThreadItem types that `item/started` and `item/completed` notifications carry.

### Key reuse: `normalizeThreadItem()` already handles this

The existing `normalizeThreadItem()` function in `codex-app-server-event-mapper.ts` accepts raw ThreadItem objects and returns typed `AppServerItem` objects. The same objects returned by `thread/read` items can be passed directly to this normalizer, then to `mapAppServerEventToPayloads()` via synthetic `as:item.completed` events. This means **no new mapping code is needed** for the core item types.

---

## 8. Summary

| Question                                     | Answer                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does `thread/read` return full conversation? | Yes, when `includeTurns: true`. Returns all turns with all items.                                                                                                  |
| Does it need a running process?              | Yes. Requires an active `codex app-server` with initialized handshake.                                                                                             |
| Can it replace Agendo's log file?            | Partially. Core conversation content (text, tools, reasoning) maps cleanly. Agendo-specific events (state machine, approvals, team, cost) cannot be reconstructed. |
| Where does Codex store data on disk?         | `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{threadId}.jsonl`                                                                                          |
| What about compacted threads?                | `thread/read` shows post-compaction state only. JSONL has full history.                                                                                            |
| What about forked threads?                   | Self-contained: fork includes parent history.                                                                                                                      |
| What about rolled-back turns?                | `thread/read` excludes them. JSONL retains them.                                                                                                                   |
| Performance for large threads?               | Single response, no pagination. May be several MB. Use generous timeout.                                                                                           |
| Can we list all threads?                     | Yes, `thread/list` with cursor pagination. Filter by cwd, source, archive status.                                                                                  |
| What's missing from thread/read?             | Cost, token usage, model per turn, streaming deltas, approval history, Agendo-specific events.                                                                     |
| Best strategy?                               | `thread/read` for active sessions; JSONL fallback for ended sessions. Enable `persistExtendedHistory: true`.                                                       |
