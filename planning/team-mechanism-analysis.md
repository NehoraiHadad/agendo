# Claude Code Team Mechanism Analysis

> Generated 2026-03-06 by investigation agent. Foundation for team UI improvements.

## 1. Team Event Types (AgendoEvent)

Defined in `src/lib/realtime/event-types.ts`:

### `team:config`

Emitted when team is first detected and re-emitted when new members join.

```typescript
{
  type: 'team:config';
  teamName: string;
  members: Array<{
    name: string; // Teammate slug (e.g. "researcher")
    agentId: string; // Format: "name@team-name"
    agentType: string; // "team-lead", "general-purpose", etc.
    model: string; // e.g. "claude-opus-4-6"
    color?: string; // UI color hint (blue, green, purple, etc.)
    planModeRequired?: boolean;
    joinedAt: number; // Unix timestamp ms
    tmuxPaneId: string; // "" for lead, "in-process" for in-process teammates
    backendType?: string; // "in-process" for in-process teammates
  }>;
}
```

### `team:message`

Teammate -> lead inbox message.

```typescript
{
  type: 'team:message';
  fromAgent: string;           // Teammate slug
  text: string;                // Markdown OR JSON-stringified payload
  summary?: string;
  color?: string;
  sourceTimestamp: string;     // ISO 8601
  isStructured: boolean;       // True when text is valid JSON
  structuredPayload?: Record<string, unknown>;
}
```

### `team:outbox-message`

Lead -> teammate outbox message.

```typescript
{
  type: 'team:outbox-message';
  toAgent: string;
  fromAgent: string;           // Always "team-lead"
  text: string;
  summary?: string;
  color?: string;
  sourceTimestamp: string;
  isStructured: boolean;
  structuredPayload?: Record<string, unknown>;
}
```

### `team:task-update`

Full snapshot of team tasks (not a diff).

```typescript
{
  type: 'team:task-update';
  tasks: Array<{
    id: string; // Numeric ("1", "2", etc.)
    subject: string;
    status: 'pending' | 'in_progress' | 'completed';
    owner?: string; // Teammate name who claimed it
    blocks: string[];
    blockedBy: string[];
  }>;
}
```

### `subagent:start`

```typescript
{
  type: 'subagent:start';
  agentId: string;
  toolUseId: string;
  subagentType?: string;
  description?: string;
}
```

### `subagent:progress` (proposed, not yet implemented)

```typescript
{
  type: 'subagent:progress';
  agentId: string;
  eventType: 'tool_use' | 'text' | 'result';
  toolName?: string;
  summary?: string;
}
```

### `subagent:complete`

```typescript
{
  type: 'subagent:complete';
  agentId: string;
  toolUseId: string;
  success: boolean;
}
```

## 2. Event Source: File Polling (NOT stream-json)

Team events do NOT come from Claude's stream-json output. They come from **file system polling** by `SessionTeamManager` (`src/lib/worker/session-team-manager.ts`):

- **Config polling** (5s): `~/.claude/teams/{name}/config.json` -> detects new members -> `team:config`
- **Inbox polling** (4s): `~/.claude/teams/{name}/inboxes/team-lead.json` -> new messages -> `team:message`
- **Outbox polling** (4s): `~/.claude/teams/{name}/inboxes/{teammate}.json` -> lead messages -> `team:outbox-message`
- **Task polling** (4s): `~/.claude/tasks/{name}/` -> task changes -> `team:task-update`

The adapter only watches for `TeamCreate`/`TeamDelete` tool events to trigger attachment/detachment.

## 3. Tool Use Attribution: CRITICAL LIMITATION

**There is NO per-teammate tool attribution from stream-json.** All tool calls appear as generic `agent:tool-start/end` from the lead session.

The ONLY source of teammate tool info is:

- `permission_request` structured messages in the inbox (when a teammate's tool gets blocked)
- These contain: `tool_name`, `tool_use_id`, `agent_id`, `description`, `input`

**Implication for UI**: We cannot show "Agent X is running Bash" unless that agent sends a permission request. We can only show what comes through inbox messages.

## 4. Structured Message Catalog

| Type                     | Direction        | Key Fields                                      |
| ------------------------ | ---------------- | ----------------------------------------------- |
| `idle_notification`      | teammate -> lead | `idleReason`                                    |
| `task_assignment`        | lead -> teammate | `taskId`, `subject`, `description`              |
| `shutdown_request`       | lead -> teammate | `requestId`, `reason`                           |
| `shutdown_approved`      | teammate -> lead | `requestId`                                     |
| `permission_request`     | teammate -> lead | `tool_name`, `tool_use_id`, `agent_id`, `input` |
| `plan_approval_request`  | teammate -> lead | `plan` or `content`                             |
| `plan_approval_response` | lead -> teammate | `request_id`, `approve`                         |

## 5. Team Message API

`POST /api/sessions/[id]/team-message` (`src/app/api/sessions/[id]/team-message/route.ts`)

Writes directly to `~/.claude/teams/{teamName}/inboxes/{recipient}.json`:

1. Finds team name via `TeamInboxMonitor.findTeamForSession()`
2. Reads current inbox JSON array
3. Appends `{ from: 'team-lead', text, summary, timestamp, color: '' }`
4. Atomic write (temp file + rename)

**Return path**: Teammate reads inbox -> processes -> writes to `team-lead.json` inbox -> SessionTeamManager polls -> emits `team:message` -> PG NOTIFY -> SSE -> UI

## 6. Subagent vs Teammate

- **Teammates** = spawned via `Task` tool with `TeamCreate` context; have `agentId` format `"name@team-name"`; are separate persistent sessions; communicate via inbox files
- **Subagents** = spawned via `Task`/`Agent` tool; exist within same session; have hex agentId; transcripts at `~/.claude/projects/.../subagents/agent-{agentId}.jsonl`

SessionTeamManager filters team member spawns from subagent spawns by checking the `@` in agentId (line 122).

## 7. Unmonitored Data Sources

| Source                   | Location                                                  | Potential                                    |
| ------------------------ | --------------------------------------------------------- | -------------------------------------------- |
| Subagent transcripts     | `~/.claude/projects/{path}/{sessionId}/subagents/*.jsonl` | Could tail for `subagent:progress` events    |
| Team member session logs | Separate Claude sessions                                  | Would need cross-session correlation         |
| Permission approvals     | Inbox files                                               | Could add endpoints for user to approve/deny |

## 8. Key Files

| File                                              | Role                                                  |
| ------------------------------------------------- | ----------------------------------------------------- |
| `src/lib/worker/session-team-manager.ts`          | Orchestrates all team event emission via file polling |
| `src/lib/worker/adapters/claude-adapter.ts`       | Watches for TeamCreate/TeamDelete tool events         |
| `src/lib/realtime/event-types.ts`                 | All event type definitions                            |
| `src/hooks/use-team-state.ts`                     | Frontend state derivation from events                 |
| `src/components/sessions/team-panel.tsx`          | Team UI panel                                         |
| `src/components/sessions/team-message-card.tsx`   | Structured message renderers                          |
| `src/components/sessions/team-diagram.tsx`        | SVG topology diagram                                  |
| `src/app/api/sessions/[id]/team-message/route.ts` | API for sending messages to teammates                 |
