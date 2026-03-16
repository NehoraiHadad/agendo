# Claude History Reconstruction: getSessionMessages / listSessions Research

**Date**: 2026-03-16
**SDK Version**: `@anthropic-ai/claude-agent-sdk` v0.2.72
**Purpose**: Replace Agendo's log-file-based session replay with Claude's native session history APIs.

---

## 1. API Signatures and Behavior

### 1.1 `getSessionMessages(sessionId, options?)`

```typescript
export declare function getSessionMessages(
  _sessionId: string,
  _options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]>;

export declare type GetSessionMessagesOptions = {
  /** Project directory to find the session in. If omitted, searches all projects. */
  dir?: string;
  /** Maximum number of messages to return. */
  limit?: number;
  /** Number of messages to skip from the start. */
  offset?: number;
};
```

**Return type:**

```typescript
export declare type SessionMessage = {
  type: 'user' | 'assistant';
  uuid: string;
  session_id: string;
  message: unknown; // MessageParam for user, BetaMessage for assistant
  parent_tool_use_id: null; // Always null in the returned type
};
```

**Implementation details (from decompiled SDK source):**

1. Validates `sessionId` as a UUID (`p4()` check). Returns `[]` for invalid IDs.
2. Finds the JSONL file on disk via `PU()`:
   - If `dir` is provided: searches the project directory (and git worktrees).
   - If omitted: searches all project directories under `~/.claude/projects/`.
3. Reads the entire JSONL file into a Buffer, then parses it line-by-line (`EU()`).
4. Parses records with `type` in `['user', 'assistant', 'progress', 'system', 'attachment']` that have a `uuid` field.
5. Builds a conversation chain via `parentUuid` links (`ZU()`):
   - Creates a UUID-to-record map.
   - Finds leaf nodes (records whose uuid is not anyone's `parentUuid`).
   - Walks backward from leaves to find the latest main-thread chain.
   - Filters out `isSidechain`, `teamName`, and `isMeta` records.
   - Follows the most recently written non-sidechain leaf to its root.
6. Filters to only `user` and `assistant` types (`CU()`).
7. Maps to the `SessionMessage` shape (`SU()`): strips `timestamp`, `cwd`, `gitBranch`, `toolUseResult`, `parentUuid`, `isSidechain`, etc.
8. Applies `offset` and `limit` on the final array.

**Key observations:**

- It reads the file synchronously into memory (entire JSONL at once).
- It only returns `user` and `assistant` messages -- no `system`, `progress`, `result`, `stream_event`, or `rate_limit_event` records.
- It follows the `parentUuid` chain to reconstruct the current conversation branch, correctly handling compaction boundaries and branching.
- `parent_tool_use_id` is hardcoded to `null` in the return -- original value is lost.
- Timestamps, cost data, model, cwd, git branch are all stripped.

### 1.2 `listSessions(options?)`

```typescript
export declare function listSessions(_options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;

export declare type ListSessionsOptions = {
  dir?: string;
  limit?: number;
  includeWorktrees?: boolean; // defaults to true
};

export declare type SDKSessionInfo = {
  sessionId: string;
  summary: string; // customTitle || lastPrompt summary || firstPrompt
  lastModified: number; // epoch ms (file mtime)
  fileSize: number; // bytes
  customTitle?: string; // from /rename command
  firstPrompt?: string; // first meaningful user prompt
  gitBranch?: string; // git branch at end of session
  cwd?: string; // working directory
};
```

**Behavior:**

- When `dir` is provided: finds the project hash directory, reads all `.jsonl` files in it. Also searches git worktrees if `includeWorktrees` is true (default).
- When `dir` is omitted: scans all directories under `~/.claude/projects/`.
- Sorts by `lastModified` descending.
- Skips sessions whose first line has `"isSidechain":true` (subagent transcripts).
- Extracts `summary` from the tail of the file (tries `customTitle`, `lastPrompt`, `summary`, then `firstPrompt`).
- Does NOT return: message count, total cost, model used, duration, or session status.

---

## 2. Response Format Examples

### 2.1 `listSessions` response (actual output)

```json
{
  "sessionId": "1ebecb92-b103-43e1-acee-88585092fc96",
  "summary": "[Previous Work Summary] Task: pg_notify...",
  "lastModified": 1773672658267,
  "fileSize": 2004069,
  "firstPrompt": "[Agendo Context: task_id=8d9a2cda...] Agendo MCP tools are available...",
  "gitBranch": "main",
  "cwd": "/home/ubuntu/projects/agendo"
}
```

### 2.2 `getSessionMessages` response (actual output)

**User message (plain text):**

```json
{
  "type": "user",
  "uuid": "c39f8ca2-...",
  "session_id": "1ebecb92-...",
  "message": {
    "role": "user",
    "content": "Fix the bug in session-process.ts"
  },
  "parent_tool_use_id": null
}
```

**User message (tool result):**

```json
{
  "type": "user",
  "uuid": "8e468d70-...",
  "session_id": "1ebecb92-...",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01GELvfYc...",
        "content": "The file has been updated successfully."
      }
    ]
  },
  "parent_tool_use_id": null
}
```

**Assistant message (thinking only):**

```json
{
  "type": "assistant",
  "uuid": "130e4652-...",
  "session_id": "1ebecb92-...",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "The user wants to fix the bug...",
        "signature": "..."
      }
    ],
    "id": "msg_01...",
    "model": "claude-opus-4-6",
    "stop_reason": null,
    "usage": { "input_tokens": 3, "output_tokens": 10, ... }
  },
  "parent_tool_use_id": null
}
```

**Assistant message (tool use):**

```json
{
  "type": "assistant",
  "uuid": "6ed510e9-...",
  "session_id": "1ebecb92-...",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_01GELvfYc...",
        "name": "Edit",
        "input": { "file_path": "/path/to/file", "old_string": "...", "new_string": "..." }
      }
    ],
    "id": "msg_01...",
    "model": "claude-opus-4-6",
    "stop_reason": "tool_use",
    "usage": { "input_tokens": 50000, "output_tokens": 200, ... }
  },
  "parent_tool_use_id": null
}
```

**Important**: The `message` field for assistant messages is a full `BetaMessage` object -- it includes `model`, `stop_reason`, `usage`, and full `content` blocks (text, thinking, tool_use). This is the raw Anthropic API response object, not a stripped-down version.

---

## 3. Mapping Table: SDK Field to Agendo DisplayItem

### 3.1 What CAN be reconstructed from `getSessionMessages()`

| Agendo DisplayItem                       | Source in SessionMessage                                        | Notes                              |
| ---------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| `kind: 'user'` → `text`                  | `msg.message.content` (when string)                             | Direct mapping                     |
| `kind: 'user'` → `hasImage`              | `msg.message.content` (array with `type: 'image'`)              | Check for image blocks             |
| `kind: 'user'` → `branchUuid`            | Previous assistant `msg.uuid`                                   | Track the preceding assistant uuid |
| `kind: 'assistant'` → text part          | `block.type === 'text'` → `block.text`                          | Direct from content blocks         |
| `kind: 'assistant'` → tool part (start)  | `block.type === 'tool_use'` → `{name, id, input}`               | Has toolName, input, toolUseId     |
| `kind: 'assistant'` → tool part (result) | Next `user` msg with `tool_result` block matching `tool_use_id` | Must pair user/assistant messages  |
| `kind: 'thinking'` → `text`              | `block.type === 'thinking'` → `block.thinking`                  | Embedded in assistant message      |

### 3.2 What CANNOT be reconstructed from `getSessionMessages()` (data loss)

| Agendo DisplayItem / Field                 | Why Missing                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `kind: 'turn-complete'` → `costUsd`        | `result` events are runtime-only, not persisted in JSONL                                |
| `kind: 'turn-complete'` → `durationMs`     | Same -- runtime `result` event only                                                     |
| `kind: 'turn-complete'` → `turns`          | Same                                                                                    |
| `kind: 'turn-complete'` → `sessionCostUsd` | Cumulative -- only tracked at runtime                                                   |
| `kind: 'info'` (system messages)           | Filtered out by `CU()` -- only user/assistant pass through                              |
| `kind: 'error'` (system errors)            | Same -- system/error records are filtered                                               |
| `kind: 'compact-loading'`                  | `compact_boundary` records exist in JSONL but are filtered by `CU()`                    |
| `kind: 'tool-approval'`                    | Runtime-only (permission request/response)                                              |
| `kind: 'team-message'`                     | Filtered by `CU()` (has `teamName`)                                                     |
| Timestamps on messages                     | `SU()` strips `timestamp` field from records                                            |
| `toolUseResult.durationMs`                 | Stripped by `SU()` (only in raw JSONL `toolUseResult` field)                            |
| `toolUseResult.numFiles`                   | Same                                                                                    |
| Model per message                          | Available in `message.model` on assistant records but not in the typed `SessionMessage` |
| Per-message usage/tokens                   | Available in `message.usage` on assistant records but not typed                         |

### 3.3 Partial data recovery via `message` field (typed as `unknown`)

Although `SessionMessage.message` is typed as `unknown`, at runtime it is:

- **For assistant**: A full `BetaMessage` object with `content`, `model`, `usage`, `stop_reason`, `id`
- **For user**: A `MessageParam` object with `role` and `content`

So you CAN extract `model` and `usage` by casting, but:

- Per-turn cost is not pre-calculated (would need token pricing tables)
- Session-level aggregations (total cost, total turns) don't exist

---

## 4. Edge Cases and Limitations

### 4.1 Active/Running Sessions

`getSessionMessages()` reads the JSONL file from disk. Claude writes to JSONL in real-time as messages are processed. So:

- **Yes, you can call it while a session is running.** It reads whatever has been flushed to disk.
- **Partially written turns** may be missing if the write hasn't been flushed yet.
- There is no locking -- it reads the file as a snapshot.
- There is **no streaming/watching** -- you must poll.

### 4.2 Compacted Sessions

When a session is compacted (`/compact` or auto-compact):

- A `compact_boundary` record is written to the JSONL.
- The pre-compaction messages remain in the file.
- `ZU()` (chain builder) follows `parentUuid` links. After compaction, the new assistant message's `parentUuid` points to a synthetic node. The chain builder walks backward and stops at the compaction boundary.
- **Result**: `getSessionMessages()` returns only the POST-compaction messages. Pre-compaction history is lost.

For Agendo: this matches the live behavior (compaction truncates visible history). But if you want to show "compacted N tokens" info, you'd need to parse the JSONL directly.

### 4.3 Branched Sessions (`--resume-session-at`)

The `parentUuid` chain naturally handles branches:

- `ZU()` finds leaf nodes and walks backward to reconstruct the active branch.
- Abandoned branches (old leaves) are ignored because the chain follows the latest leaf.
- `getSessionMessages()` returns the current active branch only.

This is the correct behavior for replay -- you see what the agent currently sees.

### 4.4 Performance

For a ~1700-line JSONL (2MB file, ~440 user + 700 assistant messages):

- File is read entirely into a Buffer in one `readFileSync` call.
- Then parsed line by line with `JSON.parse`.
- Chain building is O(n) with a Map lookup.

**Expected performance**: sub-100ms for most sessions. For very long sessions (10MB+, 10k+ lines), possibly 200-500ms.

`listSessions()` reads the head and tail of each JSONL file (optimized -- doesn't parse the whole file). Still, scanning hundreds of sessions across all projects could take seconds.

### 4.5 Session Not Found

Returns `[]` (empty array). Does not throw.

### 4.6 Invalid Session ID

Returns `[]`. The UUID validation check (`p4()`) returns false for non-UUID strings.

---

## 5. JSONL File Format (Direct Read Alternative)

### 5.1 File Location

```
~/.claude/projects/-{path-with-dashes}/{sessionId}.jsonl
```

Where `{path-with-dashes}` is the absolute project path with `/` replaced by `-` and leading `-`.

Example: project at `/home/ubuntu/projects/agendo` ->
`~/.claude/projects/-home-ubuntu-projects-agendo/{uuid}.jsonl`

### 5.2 Record Types in JSONL

| Type                       | Description                                   | Count (typical) |
| -------------------------- | --------------------------------------------- | --------------- |
| `queue-operation`          | Enqueue/dequeue markers                       | ~2 per turn     |
| `user`                     | User messages (text or tool_result)           | Many            |
| `assistant`                | Assistant messages (thinking, text, tool_use) | Many            |
| `progress`                 | Tool progress updates (elapsed time)          | Many            |
| `system:stop_hook_summary` | Stop hook execution info                      | Rare            |
| `system:compact_boundary`  | Compaction markers                            | 0-few           |
| `last-prompt`              | Last prompt text (tail record)                | 1               |

### 5.3 Rich Fields Available in Raw JSONL (not in `getSessionMessages`)

**User record:**

```typescript
{
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  isSidechain: boolean;
  promptId: string;              // unique prompt ID
  message: MessageParam;
  timestamp: string;             // ISO 8601
  permissionMode: string;        // 'bypassPermissions', etc.
  userType: string;              // 'external'
  cwd: string;
  sessionId: string;
  version: string;               // Claude CLI version
  gitBranch: string;
  toolUseResult?: {              // Rich tool result metadata
    filePath?: string;
    oldString?: string;
    newString?: string;
    originalFile?: string;
    durationMs?: number;
    numFiles?: number;
    truncated?: boolean;
  };
}
```

**Assistant record:**

```typescript
{
  type: 'assistant';
  uuid: string;
  parentUuid: string;
  isSidechain: boolean;
  requestId: string;
  message: BetaMessage; // Full API response with:
  // .content: BetaContentBlock[]  (text, thinking, tool_use)
  // .model: string                (e.g. "claude-opus-4-6")
  // .stop_reason: string | null   ("end_turn", "tool_use", null)
  // .usage: { input_tokens, output_tokens, cache_*, service_tier, inference_geo }
  // .id: string                   (API message ID)
  timestamp: string; // ISO 8601
  userType: string;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch: string;
}
```

**Progress record:**

```typescript
{
  type: 'progress';
  uuid: string;
  parentUuid: string;
  isSidechain: boolean;
  data: Record<string, unknown>;
  toolUseID: string;
  parentToolUseID: string | null;
  slug?: string;                 // tool name slug
  timestamp: string;
}
```

### 5.4 What's NOT in the JSONL

- `result` events (cost, total turns, duration) -- runtime only
- `stream_event` records (token deltas) -- runtime only
- `rate_limit_event` -- runtime only
- `system:init` (session initialization) -- runtime only
- Tool approval requests/responses -- runtime only
- `auth_status` -- runtime only

---

## 6. SDK Function vs Direct JSONL Read

### 6.1 Comparison

| Aspect                   | `getSessionMessages()`                     | Direct JSONL Read                             |
| ------------------------ | ------------------------------------------ | --------------------------------------------- |
| **Branch handling**      | Automatic (follows parentUuid chain)       | Must implement chain logic yourself           |
| **Compaction handling**  | Automatic (returns post-compaction only)   | Must handle compact_boundary records          |
| **Sidechain filtering**  | Automatic                                  | Must filter `isSidechain` records             |
| **Timestamps**           | Stripped                                   | Available                                     |
| **Usage/cost data**      | Available via `message` cast but untyped   | Available via `message.usage`                 |
| **Tool result metadata** | Lost (`toolUseResult` stripped)            | Available (`durationMs`, `numFiles`, etc.)    |
| **Model per message**    | Available via `message` cast               | Available via `message.model`                 |
| **Performance**          | Sub-100ms (reads full file)                | Same (reads full file)                        |
| **Stability**            | SDK contract (may change between versions) | File format (may change between CLI versions) |
| **Pagination**           | Built-in `limit`/`offset`                  | Must implement                                |
| **Maintenance**          | SDK handles format changes                 | Must track CLI format changes                 |

### 6.2 Recommendation

**Use a hybrid approach: direct JSONL read with SDK's chain logic as reference.**

Rationale:

1. **`getSessionMessages()` loses critical data.** Timestamps, per-message model, usage stats, and tool result metadata (durationMs, numFiles) are all stripped. Agendo needs these for proper UI rendering.

2. **The chain-building logic is well-understood.** The `ZU()` algorithm is straightforward (walk parentUuid from latest leaf). Agendo can reimplement this in ~50 lines.

3. **JSONL format is stable.** It's Claude's own persistence format. The SDK reads it -- if the format changes, the SDK changes too, so tracking SDK updates covers both.

4. **No `result` records in JSONL.** Cost/duration data is not available in either approach for historical replay. Agendo must continue using its own log files (or a DB table) for cost tracking. The JSONL approach at least gives per-message `usage` stats for rough cost estimation.

5. **`getSessionMessages()` is the right starting point for a quick prototype.** It handles branching, compaction, and sidechain filtering correctly. Start here, then switch to direct JSONL read when you need timestamps and richer data.

### 6.3 Concrete Implementation Plan

**Phase 1 (Quick Win)**: Use `getSessionMessages()` for session replay on page load.

- Call `getSessionMessages(sessionRef)` when a session detail page mounts.
- Map `SessionMessage[]` to `DisplayItem[]`:
  - User messages with string content -> `kind: 'user'`
  - User messages with `tool_result` blocks -> attach results to preceding tool parts
  - Assistant messages -> scan content blocks for `text`, `thinking`, `tool_use`
- Cast `message` to `BetaMessage` for assistant messages to extract `model` and `usage`.
- Live events continue via SSE (current system) for the running session.
- Timestamps: not available, so show "---" or estimate from message order.

**Phase 2 (Full Richness)**: Direct JSONL read.

- Implement Agendo's own JSONL parser that:
  1. Reads the file (path: `~/.claude/projects/{projectHash}/{sessionRef}.jsonl`)
  2. Parses all records, builds a `uuid -> record` Map
  3. Follows parentUuid chain from latest non-sidechain, non-isMeta leaf
  4. Returns rich records with timestamps, model, usage, toolUseResult metadata
- Add a new API endpoint: `GET /api/sessions/:id/history` that reads the JSONL.
- This gives Agendo full control over the data and doesn't depend on SDK export shape.

---

## 7. V2 API Assessment

### 7.1 `unstable_v2_createSession` / `unstable_v2_resumeSession`

```typescript
export declare function unstable_v2_createSession(_options: SDKSessionOptions): SDKSession;

export declare function unstable_v2_resumeSession(
  _sessionId: string,
  _options: SDKSessionOptions,
): SDKSession;

export declare interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}
```

### 7.2 Analysis

The V2 API is a **session lifecycle API**, not a history API:

- `unstable_v2_resumeSession()` resumes a session for new turns. It spawns a new Claude process.
- `stream()` returns an `AsyncGenerator<SDKMessage>` -- this gives the full stream of events (including `result`, `stream_event`, etc.) for **new turns only**.
- It does NOT replay historical messages.
- It does NOT provide a `getHistory()` or similar method.

**Verdict**: V2 is for driving new interactions, not replaying old ones. Use `getSessionMessages()` or direct JSONL for history reconstruction.

However, V2 could replace Agendo's current `query()` approach for session management in the future, since it provides a cleaner session abstraction with `send()` / `stream()`. This is a separate concern from history reconstruction.

### 7.3 V2 vs Current `query()` API

| Feature             | `query()` (current)                       | V2 `SDKSession`                             |
| ------------------- | ----------------------------------------- | ------------------------------------------- |
| Multi-turn          | Via AsyncIterable input                   | Via `send()` method                         |
| Resume              | Via `options.resume`                      | Via `unstable_v2_resumeSession()`           |
| Events              | `for await (const msg of q)`              | `for await (const msg of session.stream())` |
| History replay      | N/A                                       | N/A                                         |
| Stability           | Stable                                    | `unstable_v2_*` prefix -- experimental      |
| Methods on instance | `setPermissionMode()`, `setModel()`, etc. | Only `send()`, `stream()`, `close()`        |

For Agendo's session management, V2 is simpler but lacks the control methods (setPermissionMode, setModel, mcpServerStatus, etc.) that Agendo currently uses via `Query`. Not recommended for migration yet.

---

## 8. Summary of Findings

1. **`getSessionMessages()`** works reliably for basic conversation reconstruction. It handles branching, compaction, and sidechain filtering automatically. It reads the JSONL file from disk (not from a running process).

2. **Critical data gaps**: No timestamps, no cost data, no tool execution duration, no system events. The `message` field is typed as `unknown` but at runtime contains the full `BetaMessage` with model and usage data.

3. **The JSONL file format** is richer than what the SDK function returns. It includes timestamps, per-message model/usage, tool result metadata, and conversation chain data (parentUuid). It does NOT include runtime-only events like `result` (cost/duration) or `stream_event` (token deltas).

4. **`listSessions()`** provides basic session metadata (summary, timestamps, size) and can filter by project directory. Useful for building a session browser.

5. **V2 API** is not relevant for history reconstruction -- it's for driving new conversations.

6. **Recommended approach**: Start with `getSessionMessages()` for quick prototyping, then move to direct JSONL parsing for full-fidelity replay. Agendo's own event log (or DB) remains necessary for cost tracking and runtime-only events.
