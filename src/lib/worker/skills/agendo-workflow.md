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

Valid transitions:

- `todo` → `in_progress`
- `in_progress` → `done` | `blocked`
- `blocked` → `in_progress`

For subtasks: mark ALL subtasks done BEFORE marking the parent done.

---

## MCP Tool Reference

### Task Management

| Tool                  | Purpose                                            | Key Params                                                                           |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `get_my_task`         | Get your assigned task + subtasks + progress notes | _(no params)_                                                                        |
| `get_task`            | Get any task by ID + its subtasks                  | `taskId`                                                                             |
| `create_task`         | Create a new task                                  | `title`, `description?`, `priority?`, `status?`, `assignee?`, `projectId?`, `dueAt?` |
| `update_task`         | Update task fields or status                       | `taskId`, `title?`, `description?`, `priority?`, `status?`, `assignee?`, `dueAt?`    |
| `list_tasks`          | List/search tasks with filters                     | `status?`, `assignee?`, `projectId?`, `q?`, `parentTaskId?`, `limit?`, `cursor?`     |
| `list_ready_tasks`    | Tasks ready to execute (todo + all deps done)      | `projectId?`                                                                         |
| `set_execution_order` | Set ordered execution sequence                     | `taskIds` (array of UUIDs, first = order 1)                                          |

### Subtasks

| Tool             | Purpose                         | Key Params                                                        |
| ---------------- | ------------------------------- | ----------------------------------------------------------------- |
| `create_subtask` | Create a subtask under a parent | `parentTaskId`, `title`, `description?`, `priority?`, `assignee?` |
| `list_subtasks`  | List subtasks of a parent       | `taskId`                                                          |

### Progress & Context

| Tool                 | Purpose                                       | Key Params                                                                                    |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `add_progress_note`  | Log a milestone or finding                    | `note`, `taskId?` (defaults to session task)                                                  |
| `get_progress_notes` | Read progress history                         | `taskId?`                                                                                     |
| `save_snapshot`      | Preserve investigation context for resumption | `name`, `summary`, `filesExplored?`, `findings?`, `hypotheses?`, `nextSteps?`                 |
| `update_snapshot`    | Refine an existing snapshot                   | `snapshotId`, `name?`, `summary?`, `filesExplored?`, `findings?`, `hypotheses?`, `nextSteps?` |

### Projects

| Tool            | Purpose                     | Key Params                                     |
| --------------- | --------------------------- | ---------------------------------------------- |
| `list_projects` | List all projects           | `isActive?` (omit=active only, false=archived) |
| `get_project`   | Get project details by UUID | `projectId`                                    |

### Agent Sessions

| Tool                  | Purpose                                         | Key Params                                                              |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `start_agent_session` | Spawn another agent on a task (fire-and-forget) | `taskId`, `agent` (slug), `initialPrompt?`, `permissionMode?`, `model?` |
| `assign_task`         | Reassign a task to another agent                | `taskId`, `assignee` (slug)                                             |

### Plans & Artifacts

| Tool              | Purpose                                       | Key Params                                                                    |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `save_plan`       | Save/update an implementation plan (markdown) | `content`, `title?`, `planId?` (omit to create new), `visual_content?` (HTML) |
| `render_artifact` | Render interactive visual inline in chat      | `title`, `content` (HTML/SVG), `type?` ("html"\|"svg")                        |

---

## Task Creation Best Practices

### Always include projectId

Without `projectId`, the spawned agent's working directory defaults to `/tmp`. Use `list_projects` to find the right UUID.

```
create_task({
  title: "Implement user auth",
  description: "Add login/signup with Supabase Auth",
  projectId: "26d1d2e3-...",  // REQUIRED for correct working dir
  priority: "high",           // 1-5 or lowest/low/medium/high/highest
  assignee: "claude-code-1"   // agent slug
})
```

### Priority scale

| Value | Label            | Use for                     |
| ----- | ---------------- | --------------------------- |
| 1     | lowest           | Nice-to-have, backlog       |
| 2     | low              | Low urgency                 |
| 3     | medium           | Normal work (default)       |
| 4     | high             | Important, do soon          |
| 5     | highest/critical | Urgent, blocking other work |

### Break complex work into subtasks

```
create_subtask({
  parentTaskId: "...",
  title: "Write failing tests",
  assignee: "claude-code-1",
  priority: "high"
})
create_subtask({
  parentTaskId: "...",
  title: "Implement feature",
  assignee: "claude-code-1"
})
```

Use `set_execution_order` to control which tasks run first.

---

## Multi-Agent Orchestration

### Available Agents

| Slug                 | Agent          | Best for                                                              |
| -------------------- | -------------- | --------------------------------------------------------------------- |
| `claude-code-1`      | Claude Code    | Complex reasoning, architecture, full-stack dev, multi-file refactors |
| `codex-cli-1`        | OpenAI Codex   | Code generation, focused implementation tasks                         |
| `gemini-cli-1`       | Gemini CLI     | Research, analysis, alternative perspectives                          |
| `github-copilot-cli` | GitHub Copilot | Code completion, small focused tasks                                  |

### Spawning agents

```
// 1. Create subtask with assignee
create_subtask({
  parentTaskId: "...",
  title: "Implement API routes",
  assignee: "claude-code-1"
})

// 2. Launch the agent session
start_agent_session({
  taskId: "<subtask-id>",
  agent: "claude-code-1",
  initialPrompt: "Implement REST API routes for user management. Follow existing patterns in src/app/api/.",
  permissionMode: "bypassPermissions"  // default — needed for MCP + bash
})
```

### Monitoring spawned agents

- `get_task({ taskId })` — check status + subtask progress
- `list_subtasks({ taskId })` — see all subtask statuses
- `get_progress_notes({ taskId })` — read agent's notes

Sessions are fire-and-forget. The agent works autonomously and updates task status when done.

---

## Permission Modes

| Mode                | Approves                         | Blocks                           | Use when                                                                                        |
| ------------------- | -------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bypassPermissions` | Everything (bash, MCP, file ops) | Nothing                          | **Default for autonomous agents.** Required when agents need MCP tools or shell commands.       |
| `acceptEdits`       | File Read/Write/Edit only        | Bash, MCP tool calls             | Agent only needs to read/write files. **Do NOT use if agent needs MCP updates or build steps.** |
| `default`           | Nothing auto-approved            | Everything (interactive prompts) | Human-supervised sessions only.                                                                 |
| `plan`              | Read-only tools                  | All writes                       | Planning/analysis sessions — agent can explore but not modify.                                  |

**Common mistake**: Using `acceptEdits` for agents that need to call `mcp__agendo__update_task` or run `pnpm build` — they'll hang waiting for approval that never comes.

---

## Working Directory Resolution

When a session starts, the agent's working directory is resolved in this order:

1. `task.inputContext.workingDir` (if set on the task)
2. `project.rootPath` (from the linked project)
3. `agent.workingDir` (agent default)
4. `/tmp` (fallback — almost never what you want)

**This is why `projectId` on tasks is critical** — it ensures agents work in the right codebase directory.

---

## Progress Tracking Patterns

### Progress notes — use at meaningful checkpoints

```
add_progress_note({ note: "Completed API route implementation. 5 endpoints created. Starting tests." })
add_progress_note({ note: "All 12 tests passing. Moving to integration testing." })
add_progress_note({ note: "BLOCKER: Database migration fails — missing column 'email' in users table." })
```

Don't add a note for every line of code. Good checkpoints: phase completions, blockers, key decisions, test results.

### Snapshots — preserve investigation context

Use `save_snapshot` when you've explored a problem deeply and want to preserve context for resumption:

```
save_snapshot({
  name: "Auth token refresh investigation",
  summary: "Traced the token refresh flow from middleware to API...",
  filesExplored: ["src/middleware.ts", "src/lib/auth.ts"],
  findings: ["Token refresh triggers on every request, not just expired ones"],
  hypotheses: ["Race condition in concurrent refresh calls"],
  nextSteps: ["Add mutex lock to refresh flow", "Test with concurrent requests"]
})
```

---

## Plan Mode Workflow

Use `save_plan` to persist implementation plans as structured markdown:

```
save_plan({
  title: "User Authentication System",
  content: "# Auth Implementation Plan\n\n## Phase 1: Database\n- Add users table...\n\n## Phase 2: API Routes\n...",
  visual_content: "<html>...</html>"  // optional visual diagram
})
```

To update an existing plan, pass the `planId`:

```
save_plan({
  planId: "existing-plan-uuid",
  content: "# Updated plan content..."
})
```

---

## Common Mistakes & How to Avoid Them

| Mistake                                      | What happens                               | Fix                                                       |
| -------------------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| `todo → done` (skip in_progress)             | API error, status not updated              | Always transition through `in_progress` first             |
| Missing `projectId` on tasks                 | Agent works in `/tmp`, can't find codebase | Always pass `projectId` from `list_projects`              |
| `acceptEdits` for MCP-using agents           | Agent hangs on MCP tool calls              | Use `bypassPermissions` instead                           |
| Marking parent done with incomplete subtasks | Inconsistent state                         | Check `list_subtasks` before marking parent done          |
| Not calling `get_my_task` first              | Miss context, subtasks, prior notes        | Always start with `get_my_task`                           |
| Progress notes for every action              | Noisy, unhelpful history                   | Report at meaningful checkpoints only                     |
| Creating tasks without description           | Next agent lacks context                   | Always include clear description with acceptance criteria |
| Forgetting `assignee` on subtasks            | Tasks sit unassigned                       | Set assignee when creating, or use `assign_task` after    |

---

## Searching & Filtering Tasks

```
// Search by text
list_tasks({ q: "authentication" })

// Filter by status and project
list_tasks({ status: "in_progress", projectId: "..." })

// Filter by assignee
list_tasks({ assignee: "claude-code-1" })

// Pagination (100 per page default)
list_tasks({ limit: 50, cursor: "next-cursor-from-previous-response" })

// Find tasks ready to execute (todo + all deps satisfied)
list_ready_tasks({ projectId: "..." })
```

---

## Artifacts & Visuals

Use `render_artifact` for inline visuals (charts, diagrams, dashboards, UI mockups):

```
render_artifact({
  title: "Sprint Progress Dashboard",
  content: "<!DOCTYPE html><html>...</html>",
  type: "html"  // or "svg"
})
```

Requirements: self-contained HTML/SVG with inline CSS/JS. CDNs allowed (Chart.js, D3, Anime.js). Google Fonts @import allowed.

---

## Maintaining This Skill

When you add a new MCP tool or capability to the agendo project, update this skill to document it:

1. **Add the tool to the MCP Tool Reference** table in the appropriate section
2. **Update the source file** at `src/lib/worker/skills/agendo-workflow.md` (this is the source of truth — `install-skills.ts` deploys it to `~/.agents/skills/agendo/SKILL.md` on worker startup)
3. **Rebuild & restart**: `pnpm worker:build && ./scripts/safe-restart-worker.sh`

The skill file is what agents read when working with agendo. If a new tool isn't documented here, agents won't know it exists or how to use it correctly.
