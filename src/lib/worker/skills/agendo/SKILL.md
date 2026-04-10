# Agendo Agent Guide

You are managed by **Agendo** — an AI agent orchestration platform. Use `mcp__agendo__*` tools to read your assignment, report progress, and coordinate with other agents. The user sees your updates in real time on a Kanban board.

## Quick Start

**If you have an assigned task** (system prompt mentions `task_id`):

1. `get_my_task` — read your assignment, subtasks, and prior progress notes
2. `update_task({ taskId, status: "in_progress" })`
3. Do the work. Use `add_progress_note` at meaningful checkpoints
4. `update_task({ taskId, status: "done" })` when complete

**If this is a planning session** (no assigned task):

- Use `list_projects`, `create_task`, `list_tasks` to plan work
- Use `start_agent_session` to spawn agents on tasks
- Use `save_plan` to persist implementation plans

---

## Status Transitions (Enforced — Cannot Skip)

```
todo → in_progress → done
         ↕
       blocked
```

**CRITICAL**: `todo → done` WILL FAIL. Always transition through `in_progress`:

```
update_task({ taskId, status: "in_progress" })  // step 1
update_task({ taskId, status: "done" })          // step 2
```

Valid transitions: `todo→in_progress`, `in_progress→done|blocked`, `blocked→in_progress`.
Mark ALL subtasks done BEFORE marking the parent done.

---

## MCP Tools (Summary)

> Full parameter reference: `references/mcp-tools.md`

| Tool                  | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `get_my_task`         | Get your assigned task + subtasks + progress notes |
| `get_task`            | Get any task by ID + its subtasks                  |
| `create_task`         | Create a new task (always include `projectId`!)    |
| `update_task`         | Update task fields or status                       |
| `list_tasks`          | List/search tasks with filters                     |
| `list_ready_tasks`    | Tasks ready to execute (todo + all deps done)      |
| `set_execution_order` | Set ordered execution sequence                     |
| `create_subtask`      | Create a subtask under a parent                    |
| `list_subtasks`       | List subtasks of a parent                          |
| `add_progress_note`   | Log a milestone or finding                         |
| `get_progress_notes`  | Read progress history                              |
| `save_snapshot`       | Preserve investigation context for resumption      |
| `update_snapshot`     | Refine an existing snapshot                        |
| `list_projects`       | List all projects                                  |
| `get_project`         | Get project details by UUID                        |
| `start_agent_session` | Spawn another agent on a task (fire-and-forget)    |
| `assign_task`         | Reassign a task to another agent                   |
| `save_plan`           | Save/update an implementation plan (markdown)      |
| `render_artifact`     | Render interactive visual inline in chat           |

### Artifacts & File Sharing

When a visual communicates better than text — a chart, diagram, architecture overview, formatted report — use `render_artifact` to render it inline in the session view. The user sees it immediately without switching tabs or opening files.

```
render_artifact({
  title: "API Architecture",
  type: "html",
  content: "<!DOCTYPE html><html>..."
})
```

The `artifact-design` skill is pre-loaded with design guidelines — follow it for typography, color, and layout choices. Full reference with patterns and examples: `references/artifacts.md`.

**Referencing local files in artifacts**: Agendo's file server at `/api/dev/files?path=...` serves local files with correct MIME types. Use it inside artifact HTML instead of base64-encoding images (which bloats the artifact and can hit size limits):

```html
<img src="/api/dev/files?path=/home/ubuntu/projects/my-app/output/chart.png" />
```

**Sharing a browsable directory**: Give the user a link to the file viewer to explore generated output:

```
/api/dev/viewer?dir=/home/ubuntu/projects/my-app/output
```

This opens a full file browser with breadcrumb navigation, image previews, and download links. Allowed roots: `/home/ubuntu/projects`, `/tmp`.

---

## Task Creation Best Practices

Always include `projectId` — without it the agent works in `/tmp`. Use `list_projects` to find the UUID.

```
create_task({
  title: "Implement user auth",
  description: "Add login/signup with Supabase Auth",
  projectId: "26d1d2e3-...",  // REQUIRED for correct working dir
  priority: "high",           // 1-5 or lowest/low/medium/high/highest
  assignee: "claude-code-1"   // agent slug
})
```

Break complex work into subtasks. Use `set_execution_order` to control sequence.

---

## Multi-Agent Orchestration

### Available Agents

| Slug                 | Agent          | Best for                                        |
| -------------------- | -------------- | ----------------------------------------------- |
| `claude-code-1`      | Claude Code    | Complex reasoning, architecture, full-stack dev |
| `codex-cli-1`        | OpenAI Codex   | Code generation, focused implementation         |
| `gemini-cli-1`       | Gemini CLI     | Research, analysis, alternative perspectives    |
| `github-copilot-cli` | GitHub Copilot | Code completion, small focused tasks            |

### Spawning agents

```
start_agent_session({
  taskId: "<subtask-id>",
  agent: "claude-code-1",
  initialPrompt: "Implement REST API routes for user management.",
  permissionMode: "bypassPermissions"  // default — needed for MCP + bash
})
```

### Monitoring spawned agents

- `get_task({ taskId })` — check status + subtask progress
- `list_subtasks({ taskId })` — see all subtask statuses
- `get_progress_notes({ taskId })` — read agent's notes

### Inter-agent communication

> Full API reference: `references/api-endpoints.md`

After spawning a session, you can send messages to running agents. Save the `sessionId` from `start_agent_session`.

**Send a message** — `POST /api/sessions/{sessionId}/message`:

```json
{ "message": "PRIORITY UPDATE: Use OAuth2 instead of API keys." }
```

Returns `{ delivered: true }` (hot) or `{ resuming: true }` (cold resume).

**Monitor output** — `GET /api/sessions/{sessionId}/events` (SSE stream)

**Check status** — `GET /api/sessions/{sessionId}`

---

## Permission Modes

> Full guide: `references/permission-modes.md`

| Mode                | Approves      | Use when                                |
| ------------------- | ------------- | --------------------------------------- |
| `bypassPermissions` | Everything    | **Default.** Required for MCP + bash    |
| `acceptEdits`       | File ops only | Read/write files only (no MCP, no bash) |
| `default`           | Nothing       | Human-supervised sessions               |
| `plan`              | Read-only     | Planning/analysis only                  |

---

## Working Directory Resolution

1. `task.inputContext.workingDir` → 2. `project.rootPath` → 3. `agent.workingDir` → 4. `/tmp`

**This is why `projectId` on tasks is critical.**

---

## Progress Tracking

Use `add_progress_note` at meaningful checkpoints (phase completions, blockers, key decisions, test results). Don't add a note for every line of code.

Use `save_snapshot` when you've explored a problem deeply and want to preserve context for resumption.

Use `save_plan` to persist implementation plans as structured markdown.

---

## Team Delegation

When your task has **2+ independent workstreams** (e.g., backend API + frontend UI, or multiple unrelated modules), consider using `create_team` to spawn parallel agents instead of doing everything sequentially.

### When to Use Teams

- Task naturally splits into independent pieces touching different files/modules
- Multiple agents can work in parallel without file conflicts
- The speedup from parallelism outweighs the coordination overhead

### When NOT to Use Teams

- Task is small or sequential (each step depends on the previous)
- Multiple agents would need to edit the same files
- You're unsure how to split the work — just do it yourself

### Team Workflow

1. **Create the team**: `create_team` batch-creates subtasks and spawns agent sessions
   - Write self-contained prompts — agents only see their subtask description and your prompt
   - Include exact file paths, done criteria, and constraints in each member's prompt
2. **Monitor progress**: `get_team_status` shows subtask statuses and latest progress notes
3. **Coordinate**: `send_team_message` sends course corrections or context to team members
4. **Discover teammates**: `get_teammates` returns the team roster (for team members to message each other)

### Cost Awareness

Each team member consumes a **separate session** with its own token costs. A 3-member team costs roughly 3x a single session. Only delegate when the parallelism benefit justifies the cost.

---

## Common Mistakes

> Full list: `references/common-mistakes.md`

| Mistake                            | Fix                                          |
| ---------------------------------- | -------------------------------------------- |
| `todo → done` (skip in_progress)   | Always transition through `in_progress`      |
| Missing `projectId` on tasks       | Always pass `projectId` from `list_projects` |
| `acceptEdits` for MCP-using agents | Use `bypassPermissions` instead              |
| Not calling `get_my_task` first    | Always start with `get_my_task`              |

---

## Maintaining This Skill

When you add a new MCP tool or capability to the agendo project:

1. Update the appropriate file in `src/lib/worker/skills/agendo/` (source of truth)
2. `install-skills.ts` deploys the full directory to `~/.agents/skills/agendo/` on worker startup
3. **Rebuild & restart**: `pnpm worker:build && ./scripts/safe-restart-worker.sh`
