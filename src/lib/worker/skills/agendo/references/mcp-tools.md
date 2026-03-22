# MCP Tool Reference

Complete parameter reference for all `mcp__agendo__*` tools.

## Task Management

| Tool                  | Purpose                                            | Key Params                                                                           |
| --------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `get_my_task`         | Get your assigned task + subtasks + progress notes | _(no params)_                                                                        |
| `get_task`            | Get any task by ID + its subtasks                  | `taskId`                                                                             |
| `create_task`         | Create a new task                                  | `title`, `description?`, `priority?`, `status?`, `assignee?`, `projectId?`, `dueAt?` |
| `update_task`         | Update task fields or status                       | `taskId`, `title?`, `description?`, `priority?`, `status?`, `assignee?`, `dueAt?`    |
| `list_tasks`          | List/search tasks with filters                     | `status?`, `assignee?`, `projectId?`, `q?`, `parentTaskId?`, `limit?`, `cursor?`     |
| `list_ready_tasks`    | Tasks ready to execute (todo + all deps done)      | `projectId?`                                                                         |
| `set_execution_order` | Set ordered execution sequence                     | `taskIds` (array of UUIDs, first = order 1)                                          |

## Subtasks

| Tool             | Purpose                         | Key Params                                                        |
| ---------------- | ------------------------------- | ----------------------------------------------------------------- |
| `create_subtask` | Create a subtask under a parent | `parentTaskId`, `title`, `description?`, `priority?`, `assignee?` |
| `list_subtasks`  | List subtasks of a parent       | `taskId`                                                          |

## Progress & Context

| Tool                 | Purpose                                       | Key Params                                                                                    |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `add_progress_note`  | Log a milestone or finding                    | `note`, `taskId?` (defaults to session task)                                                  |
| `get_progress_notes` | Read progress history                         | `taskId?`                                                                                     |
| `save_snapshot`      | Preserve investigation context for resumption | `name`, `summary`, `filesExplored?`, `findings?`, `hypotheses?`, `nextSteps?`                 |
| `update_snapshot`    | Refine an existing snapshot                   | `snapshotId`, `name?`, `summary?`, `filesExplored?`, `findings?`, `hypotheses?`, `nextSteps?` |

## Projects

| Tool            | Purpose                     | Key Params                                     |
| --------------- | --------------------------- | ---------------------------------------------- |
| `list_projects` | List all projects           | `isActive?` (omit=active only, false=archived) |
| `get_project`   | Get project details by UUID | `projectId`                                    |

## Agent Sessions

| Tool                  | Purpose                                         | Key Params                                                              |
| --------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `start_agent_session` | Spawn another agent on a task (fire-and-forget) | `taskId`, `agent` (slug), `initialPrompt?`, `permissionMode?`, `model?` |
| `assign_task`         | Reassign a task to another agent                | `taskId`, `assignee` (slug)                                             |

## Plans & Artifacts

| Tool              | Purpose                                       | Key Params                                                                    |
| ----------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `save_plan`       | Save/update an implementation plan (markdown) | `content`, `title?`, `planId?` (omit to create new), `visual_content?` (HTML) |
| `render_artifact` | Render interactive visual inline in chat      | `title`, `content` (HTML/SVG), `type?` ("html"\|"svg")                        |

## Priority Scale

| Value | Label            | Use for                     |
| ----- | ---------------- | --------------------------- |
| 1     | lowest           | Nice-to-have, backlog       |
| 2     | low              | Low urgency                 |
| 3     | medium           | Normal work (default)       |
| 4     | high             | Important, do soon          |
| 5     | highest/critical | Urgent, blocking other work |

## Searching & Filtering Tasks

```
list_tasks({ q: "authentication" })                         // text search
list_tasks({ status: "in_progress", projectId: "..." })     // filter by status + project
list_tasks({ assignee: "claude-code-1" })                   // filter by agent
list_tasks({ limit: 50, cursor: "..." })                    // pagination (100/page default)
list_ready_tasks({ projectId: "..." })                      // ready to execute
```
