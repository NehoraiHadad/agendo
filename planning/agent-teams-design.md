# Agendo-native Agent Teams — Design

## Overview

Agendo-native Agent Teams enables cross-provider team orchestration through MCP tools. An orchestrator agent (team lead) creates a team by batch-creating subtasks and spawning agent sessions, then monitors progress and sends messages to coordinate work.

**Key principle**: Compose existing primitives (`create_subtask` + `start_agent_session` + message API) into higher-level team operations, not a parallel system.

## New MCP Tools

### 1. `create_team(taskId, members[])`

Batch operation that:

1. Creates a subtask for each member under the parent task
2. Spawns an agent session for each subtask with the member's initial prompt
3. Returns all session IDs and subtask IDs for tracking

```typescript
// Input
{
  taskId: string;           // Parent task UUID (orchestrator's task)
  members: [{
    agent: string;          // Agent slug (e.g. "claude-code-1", "codex-cli-1")
    role: string;           // Subtask title / role description
    prompt: string;         // Initial prompt for the agent session
    permissionMode?: string; // Default: "bypassPermissions"
    model?: string;         // Optional model override
  }]
}

// Output
{
  teamId: string;           // Parent task ID (serves as team identifier)
  members: [{
    agent: string;
    subtaskId: string;
    sessionId: string;
  }]
}
```

**Implementation**: Sequential `apiCall` to POST `/api/tasks` (create subtask) then POST `/api/sessions` (spawn session) for each member. The parent taskId is the "team ID".

### 2. `send_team_message(sessionId, message)`

Proxy to POST `/api/sessions/:id/message`. Simple convenience wrapper.

```typescript
// Input
{
  sessionId: string;  // Target session UUID
  message: string;    // Message text
}

// Output
{ delivered: true } | { resuming: true }
```

### 3. `get_team_status(taskId)`

Aggregates subtask statuses + latest progress notes + session states for all subtasks under a parent task.

```typescript
// Input
{
  taskId: string;  // Parent task UUID
}

// Output
{
  taskId: string;
  title: string;
  status: string;
  members: [{
    subtaskId: string;
    title: string;
    status: string;          // todo | in_progress | done
    assignee: string | null; // Agent slug
    latestNote: string | null;
    sessionId: string | null;
    sessionStatus: string | null; // active | awaiting_input | idle | ended
  }]
}
```

**Implementation**: Fetch parent task + subtasks, then for each subtask fetch latest progress note and find active session.

## Orchestrator Preamble

Added to `session-preambles.ts` as `generateTeamLeadPreamble()`. Injected when a session is created with a special `teamLead: true` flag or when the task description contains team coordination instructions.

The preamble teaches the orchestrator to:

1. Use `create_team` to spawn team members
2. Poll `get_team_status` periodically to monitor progress
3. Use `send_team_message` to send course corrections
4. Use `add_progress_note` to track orchestration decisions
5. Collect results and mark parent task done when all subtasks complete

## How Teams Map to Existing Model

```
Parent Task (orchestrator's task, team ID)
├── Subtask 1 (assigned to claude-code-1) → Session A
├── Subtask 2 (assigned to codex-cli-1)   → Session B
└── Subtask 3 (assigned to gemini-cli-1)  → Session C

Orchestrator Session (on parent task) monitors all subtasks
```

No new database tables needed. The parent task serves as the team container, subtasks are team member assignments, and sessions are the execution contexts.

## File Structure

```
src/lib/mcp/tools/team-tools.ts    — create_team, send_team_message, get_team_status
src/lib/mcp/tools/index.ts         — register team tools
src/lib/worker/session-preambles.ts — team lead preamble
src/lib/mcp/tools/__tests__/team-tools.test.ts — unit tests
```

## What's NOT in Scope (Phase 1)

- Team templates (predefined team compositions) — future enhancement
- UI "Create Team" button — future enhancement
- Real-time team panel integration for Agendo-native teams — existing panel works for Claude teams
- Team lifecycle management (dissolve team, replace member) — agents can do this manually
