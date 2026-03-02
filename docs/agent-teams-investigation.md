# Agent Teams & Subagents — Technical Investigation Report

> **Status**: Research complete (2026-03-02)
> **Author**: Claude Code (investigation session)
> **Purpose**: Inform implementation of Backend Events, Team Panel UI, and Topology Diagram features

---

## 1. Mechanism Overview

Claude Code provides two distinct parallelism mechanisms that differ fundamentally in their isolation model and communication patterns.

| Dimension         | Subagents (Agent/Task tool)                                        | Agent Teams (TeamCreate)                            |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------- |
| **Scope**         | Within a single session                                            | Separate independent sessions                       |
| **Context**       | Sub-context inside parent conversation                             | Own full context window; lead's history NOT shared  |
| **Communication** | Result returns to parent only                                      | Direct peer-to-peer messaging via inbox files       |
| **Coordination**  | Parent manages all work                                            | Shared task list, self-claim                        |
| **Transcript**    | `~/.claude/projects/{proj}/{sessionId}/subagents/agent-{id}.jsonl` | Each member is a full session                       |
| **Config**        | Frontmatter in `~/.claude/agents/*.md`                             | `~/.claude/teams/{name}/config.json`                |
| **Nesting**       | Cannot spawn further subagents                                     | Cannot create nested teams                          |
| **Token cost**    | Lower (results summarized back)                                    | High (each teammate = full Claude instance)         |
| **Use when**      | Focused task, result matters, no peer communication                | Parallel independent work requiring peer discussion |

**Enabling agent teams**: requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json (currently set in this environment).

---

## 2. Subagents (Agent Tool) — Deep Dive

### 2.1 How It Works

When the agent calls the `Task` tool (renamed `Agent` in Claude Code v2.1.63; `Task` still works as an alias), Claude Code spawns a sub-process with:

- Its own context window
- The `prompt` parameter as its first user message
- Tool access controlled by `tools`/`disallowedTools`
- A separate transcript file

The tool runs **asynchronously by default** (returns immediately). The parent agent gets a response like:

```
Async agent launched successfully.
agentId: ae237a4673724f9f3 (internal ID)
output_file: /tmp/claude-1001/-home-ubuntu-projects-agendo/tasks/ae237a4673724f9f3.output
```

For **team member spawning** (via TeamCreate), the response is different:

```
Spawned successfully.
agent_id: frontend-analyst@agent-ide-architecture
name: frontend-analyst
team_name: agent-ide-architecture
The agent is now running and will receive instructions via mailbox.
```

### 2.2 Transcript File Format

**Location**: `~/.claude/projects/{encoded-project-path}/{parentSessionId}/subagents/agent-{agentId}.jsonl`

Each line is a JSON object. All records share these base fields:

```json
{
  "parentUuid": "uuid-of-parent-message",
  "isSidechain": true,
  "userType": "external",
  "cwd": "/home/ubuntu/projects/agendo",
  "sessionId": "parent-session-uuid",
  "version": "2.1.42",
  "gitBranch": "HEAD",
  "agentId": "a2535cc",
  "slug": "delegated-sniffing-manatee",
  "type": "user" | "assistant" | "progress",
  "uuid": "line-unique-uuid",
  "timestamp": "2026-02-17T12:36:07.464Z"
}
```

**Three event types observed in real transcripts:**

#### `type: "user"` — Initial prompt and tool results

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "<teammate-message teammate_id=\"team-lead\" summary=\"...\">...</teammate-message>"
  }
}
```

The initial user message is the raw `prompt` parameter. For team members, it's wrapped in `<teammate-message>` XML.

#### `type: "assistant"` — Agent responses

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_01ETXwkQVsyeuZD3dXDvfqGr",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "text", "text": "..."},
      {"type": "tool_use", "id": "toolu_...", "name": "Read", "input": {...}}
    ],
    "stop_reason": null,
    "usage": {"input_tokens": 3, "cache_creation_input_tokens": 733, ...}
  },
  "requestId": "req_011CYD..."
}
```

#### `type: "progress"` — Hook execution events

```json
{
  "type": "progress",
  "data": {
    "type": "hook_progress",
    "hookEvent": "PostToolUse",
    "hookName": "PostToolUse:Read",
    "command": "callback"
  },
  "parentToolUseID": "toolu_01JK75yirtVbHQ8TPDTfWYzd",
  "toolUseID": "toolu_01JK75yirtVbHQ8TPDTfWYzd"
}
```

There is also a **compact boundary event** documented (but not captured in logs here):

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compactMetadata": { "trigger": "auto", "preTokens": 167189 }
}
```

### 2.3 How Agendo Sees the Agent Tool (stream-json protocol)

In Agendo's stream-json mode, the `Task`/`Agent` tool appears as **ordinary tool calls**:

```json
// agent:tool-start event (from session log)
{
  "type": "agent:tool-start",
  "toolUseId": "toolu_01F8TtifqHajwWmYteR8xbQi",
  "toolName": "Task",
  "input": {
    "description": "Analyze frontend architecture",
    "subagent_type": "feature-dev:code-explorer",
    "prompt": "You are the FRONTEND ARCHITECT..."
  }
}

// agent:tool-end event (content = launch confirmation text)
{
  "type": "agent:tool-end",
  "toolUseId": "toolu_01F8TtifqHajwWmYteR8xbQi",
  "content": [
    {
      "type": "text",
      "text": "Async agent launched successfully.\nagentId: ae237a4673724f9f3\n..."
    }
  ]
}
```

**Key finding**: The `Task` tool does NOT emit any special stream events. Progress of the subagent is not visible in the parent session's stream-json output at all. The only signals are:

1. `agent:tool-start` when the parent calls `Task` (subagent spawned)
2. `agent:tool-end` with launch confirmation text (immediately, fire-and-forget)
3. A later `agent:tool-start` (parent calls `TaskOutput` to check progress)

Subagent completion triggers a new assistant turn in the parent session (via the background notification mechanism), but this just arrives as another `agent:text` event.

### 2.4 Live Monitoring of Subagent Transcripts

The transcript files **can** be watched with `fs.watch` or polling because they're appended line-by-line in JSONL format. This is the only way to see real-time progress of a subagent from outside the Claude CLI.

**File naming pattern**: The `agentId` in the filename comes from the `agentId` field in the launch response text (e.g., `ae237a4673724f9f3`). The full path is:

```
~/.claude/projects/{encoded-path}/{parentSessionId}/subagents/agent-{agentId}.jsonl
```

Where `{encoded-path}` encodes the project directory path by replacing `/` with `-`.

---

## 3. Agent Teams — Deep Dive

### 3.1 File System Layout

```
~/.claude/
├── teams/
│   └── {team-name}/
│       ├── config.json          # Team config + member list
│       └── inboxes/
│           ├── team-lead.json   # Lead's inbox (what Agendo monitors)
│           ├── researcher.json  # Teammate inboxes
│           └── implementer.json
└── tasks/
    └── {team-name}/
        ├── 1.json               # Task files (numeric IDs)
        ├── 2.json
        └── 3.json
```

### 3.2 Team Config Schema

**File**: `~/.claude/teams/{team-name}/config.json`

```json
{
  "name": "design-overhaul",
  "description": "Complete visual identity overhaul",
  "createdAt": 1770503112846,
  "leadAgentId": "team-lead@design-overhaul",
  "leadSessionId": "592a7842-ff3e-4373-a97e-08375ba53a3d",
  "members": [
    {
      "agentId": "team-lead@design-overhaul",
      "name": "team-lead",
      "agentType": "team-lead",
      "model": "claude-opus-4-6",
      "joinedAt": 1770503112846,
      "tmuxPaneId": "",
      "cwd": "/home/ubuntu/projects/story-creator",
      "subscriptions": []
    },
    {
      "agentId": "researcher@design-overhaul",
      "name": "researcher",
      "agentType": "general-purpose",
      "model": "claude-opus-4-6",
      "prompt": "You are the UI/UX researcher...",
      "color": "blue",
      "planModeRequired": false,
      "joinedAt": 1770503214956,
      "tmuxPaneId": "in-process",
      "cwd": "/home/ubuntu/projects/story-creator",
      "subscriptions": [],
      "backendType": "in-process"
    }
  ]
}
```

**Field semantics**:
| Field | Description |
|-------|-------------|
| `leadSessionId` | The Claude CLI `session_id` (from `system/init` `session_id` field). This is what `TeamInboxMonitor.findTeamForSession()` matches against. |
| `leadAgentId` | Format: `"team-lead@{team-name}"` |
| `agentId` (member) | Format: `"{name}@{team-name}"` |
| `tmuxPaneId` | `""` for team lead; `"in-process"` for in-process teammates; pane ID if using tmux/iTerm2 |
| `backendType` | `"in-process"` for teammates created via `Task` tool in stream-json mode |
| `planModeRequired` | `true` to require plan approval before implementation |
| `subscriptions` | Reserved, always `[]` in observed configs |
| `color` | Used for coloring messages: `"blue"`, `"green"`, `"purple"`, `"red"`, `"yellow"`, `"orange"`, `"cyan"`, `"pink"` |

**`leadSessionId` lifecycle**: Set at team creation time (when `TeamCreate` tool runs). The value comes from the `session_id` field in Claude CLI's `system/init` stream event. This is what `TeamInboxMonitor.findTeamForSession()` uses to associate a session with its team.

### 3.3 Task File Schema

**File**: `~/.claude/tasks/{team-name}/{id}.json`

```json
{
  "id": "1",
  "subject": "Audit current UI state with Playwright screenshots",
  "description": "Take screenshots of ALL key pages...",
  "activeForm": "Taking baseline UI screenshots with Playwright",
  "owner": "researcher",
  "status": "completed",
  "blocks": ["4", "5", "6"],
  "blockedBy": []
}
```

**All observed field values**:
| Field | Type | Description |
|-------|------|-------------|
| `id` | string (numeric) | Sequential: `"1"`, `"2"`, `"3"`... |
| `subject` | string | Short task title |
| `description` | string | Full task description (can be very long) |
| `activeForm` | string | Present-progressive form: "Running tests..." |
| `owner` | string | Teammate name who claimed this task |
| `status` | `"pending"` \| `"in_progress"` \| `"completed"` | Task lifecycle |
| `blocks` | `string[]` | IDs of tasks that cannot start until this completes |
| `blockedBy` | `string[]` | IDs of tasks that must complete before this can start |

**Notes**: `owner` may be absent if unassigned. File locking prevents concurrent claims.

### 3.4 Inbox File Schema

**File**: `~/.claude/teams/{team-name}/inboxes/{member-name}.json`

The file is a **JSON array** of message objects (not JSONL), appended by Claude Code as messages are sent.

```json
[
  {
    "from": "advocate-atmosphere",
    "text": "Task #2 complete...",
    "summary": "Asset audit complete: 39% dead CSS",
    "timestamp": "2026-02-07T22:29:41.445Z",
    "color": "green",
    "read": true
  },
  {
    "from": "advocate-atmosphere",
    "text": "{\"type\":\"idle_notification\",\"from\":\"advocate-atmosphere\",...}",
    "timestamp": "2026-02-07T22:29:44.091Z",
    "color": "green",
    "read": true
  }
]
```

**Field semantics**:
| Field | Required | Description |
|-------|----------|-------------|
| `from` | Yes | Sender's member `name` (slug) |
| `text` | Yes | Message body — plain markdown OR JSON-stringified structured payload |
| `summary` | No | Short 5-10 word summary for preview |
| `timestamp` | Yes | ISO 8601 timestamp |
| `color` | No | Sender's color from team config |
| `read` | No | `true` after recipient has processed; absent = unread |

### 3.5 Structured Message Catalog

When `text` is a JSON-stringified object, it's a **protocol message**. All 5 types observed in real data:

#### `idle_notification` — Teammate went idle

Sent automatically by Claude Code whenever a teammate finishes their turn and has no more work.

```json
{
  "type": "idle_notification",
  "from": "advocate-atmosphere",
  "timestamp": "2026-02-07T22:29:44.091Z",
  "idleReason": "available"
}
```

**`idleReason` values observed**: `"available"` (normal idle) | `"interrupted"` (stopped mid-task)

---

#### `task_assignment` — Lead assigns a task to a teammate

```json
{
  "type": "task_assignment",
  "taskId": "3",
  "subject": "Wave 2A: Hooks — use-local-draft-storage, use-cloud-draft-sync",
  "description": "Update hooks to use sessionId...",
  "assignedBy": "team-lead",
  "timestamp": "2026-02-22T06:31:22.360Z"
}
```

---

#### `shutdown_request` — Lead requests graceful shutdown

```json
{
  "type": "shutdown_request",
  "requestId": "shutdown-1771742824039@backend-agent",
  "from": "team-lead",
  "reason": "All work is complete and verified. Thank you!",
  "timestamp": "2026-02-22T06:47:04.039Z"
}
```

**`requestId` format**: `"shutdown-{epochMs}@{recipientName}"`

---

#### `shutdown_approved` — Teammate confirms shutdown

Sent by the teammate to the lead's inbox after receiving a shutdown_request.

```json
{
  "type": "shutdown_approved",
  "requestId": "shutdown-1771742826247@quality-agent",
  "from": "teammate",
  "timestamp": "2026-02-22T06:47:26.989Z"
}
```

---

#### `permission_request` — Teammate requests approval for a blocked tool

Sent by a teammate to the lead's inbox when their permission mode blocks a tool and they need manual approval.

```json
{
  "type": "permission_request",
  "request_id": "perm-1772198751267-qg34ibn",
  "agent_id": "product-researcher",
  "tool_name": "Bash",
  "tool_use_id": "toolu_01QEqQsGPQbN4yCcaudgLFap",
  "description": "Find .claude directories and CLAUDE.md files in projects",
  "input": {
    "command": "find /home/ubuntu/projects -name \".claude\" -type d 2>/dev/null | head -20",
    "description": "Find .claude directories and CLAUDE.md files in projects"
  },
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Read", "ruleContent": "//home/ubuntu/projects/**" }],
      "behavior": "allow",
      "destination": "session"
    }
  ]
}
```

---

#### `plan_approval_request` / `plan_approval_response` (documented, not observed)

These are described in the official docs and the Claude Code `SendMessage` tool description:

**`plan_approval_request`** (teammate → lead):
Sent when `planModeRequired=true` teammate calls `ExitPlanMode`. The lead receives this in its inbox. Fields include the plan content.

**`plan_approval_response`** (lead → teammate):
Sent by the lead after reviewing the plan request. Fields: `{ type, request_id, approve: boolean, content? }`.

_Note: No real examples were found in this environment's team history, indicating this mechanism was never exercised with `planModeRequired: true` teammates._

---

### 3.6 Team Lifecycle State Machine

```
User prompt
     │
     ▼
[TeamCreate tool called by lead agent]
     │ Creates config.json (with leadSessionId = current session_id)
     │ Creates inboxes/ directory
     │ Returns team name
     ▼
[Task tool called to spawn each teammate]
     │ Adds member entry to config.json (tmuxPaneId="in-process")
     │ Returns "Spawned successfully. agent_id: ..."
     │ Teammate starts, reads its inbox for messages
     ▼
[Teammates work + send idle_notification]
     │ Write to team-lead.json inbox
     │ Lead polls inbox every ~4s (Agendo's TeamInboxMonitor)
     ▼
[Lead sends task_assignment to teammate inbox]
     │ Writes to {teammate}.json inbox
     │ Teammate reads inbox, processes task
     ▼
[Teammate sends plain message + idle_notification to lead]
     │
     ▼
[Lead sends shutdown_request to teammate inbox]
     │ Teammate sends shutdown_approved to team-lead.json
     ▼
[TeamDelete tool called by lead]
     │ All members sent shutdown_approved
     │ Config file deleted (triggers isTeamDisbanded() = true)
     ▼
[Team disbanded]
```

---

## 4. Agendo Current State

### 4.1 What Agendo Currently Tracks

| Feature                                          | Status     | Code                                                                          |
| ------------------------------------------------ | ---------- | ----------------------------------------------------------------------------- |
| Detect if session is a team leader               | ✅ Working | `TeamInboxMonitor.findTeamForSession()` scans `~/.claude/teams/*/config.json` |
| Poll team-lead inbox for new messages            | ✅ Working | `startPolling(4000ms, ...)` in `session-team-manager.ts`                      |
| Emit `team:message` event for each inbox message | ✅ Working | Both backfill and live messages                                               |
| Parse structured payloads (isStructured flag)    | ✅ Working | `parseRawMessage()` tries JSON.parse on text                                  |
| Reset idle timeout when team is active           | ✅ Working | `recordActivity()` on each message                                            |
| Inject plain messages into agent stdin           | ✅ Working | Only when `!msg.isStructured && status === 'awaiting_input'`                  |
| Detect team disbanding (all shutdown_approved)   | ✅ Working | `isTeamDisbanded()` checks config + messages                                  |
| Attach on cold-resume (existing team on disk)    | ✅ Working | `start()` → `tryAttach()`                                                     |
| Detect TeamCreate/TeamDelete events              | ✅ Working | `onToolEvent()` watches tool-start/end                                        |

### 4.2 What the Frontend Shows

`TeamMessageCard` in `session-chat-view.tsx` renders:

- `idle_notification` → compact colored dot badge (`● researcher idle`)
- `task_assignment` → compact card showing task ID and summary
- Plain messages → collapsible markdown card (collapses after 6 lines)
- All other structured messages → rendered as raw markdown (the JSON text is shown as-is)

Colors mapped from `color` field: blue, green, purple, red, yellow, orange, cyan → Tailwind classes.

### 4.3 Critical Gaps

| Gap                                                             | Impact                                            | Notes                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Team member list never sent to frontend**                     | No topology view possible                         | Config.json is read on-disk but members[] array is never emitted as an event      |
| **No `team:config` event type**                                 | Frontend doesn't know who's on the team           | Would need a new event type in `events.ts`                                        |
| **Teammate inboxes not monitored**                              | No visibility into lead→teammate messages         | Only team-lead.json is watched; `inboxes/{teammate}.json` is never read by Agendo |
| **Task list never read**                                        | No task progress display                          | `~/.claude/tasks/{name}/*.json` files are completely ignored                      |
| **No `team:task-update` event**                                 | Can't show Kanban for Claude team tasks           | Would require polling or fs.watch on task directory                               |
| **Subagent transcripts never read**                             | No subagent progress in Agendo UI                 | `~/.claude/projects/.../subagents/agent-*.jsonl` files untouched                  |
| **No subagent topology**                                        | Can't show parent-child agent relationships       | agentId from tool-start result text is parseable but not captured                 |
| **`shutdown_request`/`shutdown_approved` rendered as raw JSON** | Ugly UI for protocol messages                     | Only idle_notification and task_assignment have special renderers                 |
| **`permission_request` not actionable from UI**                 | User can't approve teammate tool calls via Agendo | Would need control flow to write to teammate inbox                                |
| **No per-teammate message threads**                             | All messages mixed in one flat list               | fromAgent field exists but no grouping                                            |
| **Writing to teammate inboxes not implemented**                 | Agendo UI can't message teammates directly        | Technically feasible (write to inbox JSON), but needs careful implementation      |

---

## 5. Implementation Recommendations

### 5.1 Backend Events (New AgendoEvent types + worker changes)

#### New event: `team:config`

Emit when a team is first detected (attach) and after each poll that detects config changes.

```typescript
// Add to events.ts AgendoEvent union:
| (EventBase & {
    type: 'team:config';
    teamName: string;
    members: Array<{
      name: string;
      agentId: string;
      agentType: string;
      model: string;
      color?: string;
      planModeRequired?: boolean;
      joinedAt: number;
      tmuxPaneId: string;
      backendType?: string;
    }>;
  })
```

**Where to emit**: In `session-team-manager.ts` `tryAttach()`, after creating the monitor. Read `config.json` and emit `team:config` immediately. Additionally, poll config.json every ~5s for member additions (teammates join asynchronously after spawn).

#### New event: `team:task-update`

Emit when task files change (poll `~/.claude/tasks/{teamName}/` every 4s).

```typescript
| (EventBase & {
    type: 'team:task-update';
    tasks: Array<{
      id: string;
      subject: string;
      status: 'pending' | 'in_progress' | 'completed';
      owner?: string;
      blocks: string[];
      blockedBy: string[];
    }>;
  })
```

**Where to emit**: Add a `TeamTaskMonitor` class (similar to `TeamInboxMonitor`) that polls the task directory and diffs against last known state. Emit on any change.

#### Extend `TeamInboxMonitor` to monitor ALL inboxes

Currently only watches `team-lead.json`. Add a method to return all inbox paths:

```typescript
// New method:
listAllInboxPaths(): string[]  // returns all {member}.json paths

// New event type for lead→teammate messages:
| (EventBase & {
    type: 'team:outbox-message';
    toAgent: string;  // which teammate received this
    fromAgent: string;
    text: string;
    isStructured: boolean;
    structuredPayload?: Record<string, unknown>;
    sourceTimestamp: string;
  })
```

**Concern**: All messages from lead to teammate are currently invisible. Monitoring all inboxes gives Agendo visibility into the full conversation graph.

#### Subagent transcript monitoring

Add `SubagentTracker` that watches `~/.claude/projects/{encodedPath}/{sessionId}/subagents/` for new `.jsonl` files and tails them:

```typescript
| (EventBase & {
    type: 'subagent:start';
    agentId: string;
    toolUseId: string;
    subagentType?: string;
    description?: string;
  })
| (EventBase & {
    type: 'subagent:progress';
    agentId: string;
    eventType: 'tool_use' | 'text' | 'result';
    toolName?: string;
    summary?: string;
  })
| (EventBase & {
    type: 'subagent:complete';
    agentId: string;
    success: boolean;
  })
```

The `agentId` in `agent:tool-end` content text can be parsed with a regex: `/agentId: ([a-f0-9]+)/`.

**Important**: The parent session's `agent:tool-start` with `toolName: "Task"` already fires. The `agentId` from the tool result needs to be correlated with the subagent's transcript file. Session ID for lookup = the Agendo session's `sessionRef` (from `session:init` event).

### 5.2 Team Panel UI

#### Team roster panel (reads from `team:config` events)

- Show all members with their color dot, name, agentType
- Indicate active vs idle (correlate with latest `idle_notification`)
- Show `planModeRequired` badge

#### Per-teammate message threads

Instead of flat list, group `team:message` by `fromAgent`. Each teammate gets a collapsible section.

```
[● researcher (blue)]  3 messages
  ↳ Task #1 complete: screenshots taken...
  ↳ idle 2m ago
  ↳ [idle notification badge]

[● implementer (purple)]  5 messages
  ...
```

#### Task list panel (reads from `team:task-update` events)

Mini Kanban with three columns: Pending | In Progress | Completed. Show `owner` on each card. Task dependency arrows optional (complex).

#### Structured message renderers (currently missing)

Add renderers for:

- `shutdown_request` → "⏹ Shutdown request sent to {from}"
- `shutdown_approved` → "✓ {from} approved shutdown"
- `permission_request` → expandable card with tool name, input, and approve/deny buttons (requires backend action endpoint)
- `plan_approval_request` → "📋 {from} submitted a plan for approval" + approve/reject UI

### 5.3 Topology Diagram

The topology must track two distinct layers:

**Layer 1: Agent Teams topology** (file-based, stable)

- Source: `team:config` events → members[] array
- Nodes: team-lead + each teammate
- Edges: lead-spawned-teammate (from TeamCreate + Task calls)
- State: idle/active per member (from idle_notification timestamps)

**Layer 2: Subagent topology** (within-session, transient)

- Source: `agent:tool-start` events with `toolName: "Task"` (or new `subagent:start` events)
- Nodes: parent session + each subagent
- Edges: parent→subagent (from toolUseId correlation)
- State: running/complete (from tool-end events)

**Data model for topology state** (store in Zustand, update from SSE events):

```typescript
interface TopologyNode {
  id: string; // agentId or session UUID
  label: string; // name or description
  type: 'session' | 'teammate' | 'subagent';
  status: 'active' | 'idle' | 'complete' | 'error';
  color?: string;
  model?: string;
}

interface TopologyEdge {
  from: string;
  to: string;
  type: 'spawned' | 'messages';
}
```

**Rendering**: Use a lightweight force-directed graph library (e.g., `d3-force` or `react-flow`). The topology is small (<20 nodes typically), so performance is not a concern.

---

## 6. Risks & Gotchas

### 6.1 Writing to Teammate Inboxes

Agendo could write to `~/.claude/teams/{name}/inboxes/{member}.json` to send messages from the UI directly to teammates. However:

- **Race condition**: Claude Code appends to this file; Agendo would need to read, parse, append, and rewrite atomically. Use a file lock or write a temp file + rename.
- **Format requirement**: Must be a valid JSON array after write. Even a partial write corrupts the inbox and breaks the teammate.
- **Message format**: Must match exactly: `{ from, text, timestamp, color?, summary? }`. The `from` field should be `"team-lead"` for messages the user sends.
- **No ACK mechanism**: You can't tell if the teammate actually read/processed the message.

**Recommendation**: Safe to implement but use `fs.writeFileSync` with atomic rename (`tmp → target`) to prevent corruption. Never use `fs.appendFileSync` directly.

### 6.2 Config.json Polling Race

Members are added to `config.json` after each `Task` tool call. The file may be partially written during a `JSON.parse` attempt. Current `TeamInboxMonitor` handles this with try/catch — any polling of `config.json` must do the same.

### 6.3 `leadSessionId` vs Agendo Session ID

The `leadSessionId` in team config is the **Claude CLI's own session ID** (from `system/init` event, field `session_id`). This is **not** the Agendo session UUID. The correlation:

- Agendo session UUID: `session.id` in DB
- Claude CLI session ID: stored as `session.sessionRef` after receiving `session:init` event

`TeamInboxMonitor.findTeamForSession()` takes the Claude CLI session ID (`sessionRef`), not the Agendo UUID. This is already correct in `session-process.ts`.

### 6.4 Task File Locking

Claude Code uses file locking on task JSON files to prevent concurrent claims. Agendo should **only read** task files, never write to them (unless adding a future "reassign task" feature). Reading is always safe.

### 6.5 Subagent Transcript Path Encoding

The project path encoding in the transcript path (`/home/ubuntu/projects/agendo` → `-home-ubuntu-projects-agendo`) uses simple slash→hyphen replacement. But be careful: `/home/ubuntu/projects/my-project` would collide with `/home/ubuntu/projects/my` + `project/`. Check the actual directory existence after encoding.

The agentId from the `Task` tool response can be parsed from the `agent:tool-end` content:

```typescript
const match = content.match(/agentId: ([a-f0-9]+)/);
const agentId = match?.[1];
```

For team member spawns, the format is different:

```
agent_id: frontend-analyst@agent-ide-architecture
name: frontend-analyst
team_name: agent-ide-architecture
```

### 6.6 `plan_approval_request` Not Yet Observed

No real example was found in this environment's history. The mechanism is documented in the Claude Code `SendMessage` tool description but may not be widely used. Implementation can proceed based on the documented format but should be tested with a `planModeRequired: true` teammate.

### 6.7 `idleReason: "interrupted"` Semantics

When `idleReason` is `"interrupted"`, the teammate was mid-task when it stopped (e.g., due to a `Cancel` action). The lead should check if the interrupted task is still `in_progress` and decide whether to reassign or resume.

### 6.8 Inbox Backfill on Cold Resume

`SessionTeamManager.tryAttach()` already backfills all existing messages via `readAllMessages()` and emits them as `team:message` events. This works for the team-lead inbox. When adding monitoring of other inboxes (lead→teammate messages), the same backfill approach should be used.

### 6.9 Team Name Stability

Team names are user-provided strings (e.g., `"design-overhaul"`, `"agendo-realtime"`). They're stable for the lifetime of the team. The team directory is deleted on `TeamDelete`. After deletion, `TeamInboxMonitor.isTeamDisbanded()` returns `true` because `existsSync(configPath)` is false.

### 6.10 Token Cost Warning

Agent teams are extremely expensive. Each teammate is a full Claude session. A 10-member team doing a 100-turn task costs roughly 10× the tokens of a single session. The Topology Diagram UI should prominently display active teammate count to help users understand token burn rate.

---

## Appendix: Real Data Sources

All schemas above were derived from real files on this server. Key examples:

| File                                                                                  | Key data                                                                                     |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `~/.claude/teams/design-overhaul/config.json`                                         | 9-member team, all fields including `prompt`, `color`, `planModeRequired`, `backendType`     |
| `~/.claude/teams/design-overhaul/inboxes/team-lead.json`                              | 30 messages, 13 structured, confirmed `idle_notification` fields                             |
| `~/.claude/teams/agent-ide-architecture/inboxes/team-lead.json`                       | `permission_request` real example                                                            |
| `~/.claude/tasks/design-overhaul/1.json` through `26.json`                            | Full task file schema including `blocks`/`blockedBy`                                         |
| `~/.claude/projects/-home-ubuntu-projects/d72089b0-.../subagents/agent-a8221ff.jsonl` | 204-line transcript with `user`, `assistant`, `progress` types                               |
| `/data/agendo/logs/sessions/2026/02/0ac42096-...log`                                  | Full session with `Task` tool calls; `team:config`, `team:message` events; `TeamCreate` tool |
