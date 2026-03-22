# Common Mistakes & How to Avoid Them

## Task Lifecycle

| Mistake                                      | What happens                        | Fix                                              |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `todo → done` (skip in_progress)             | API error, status not updated       | Always transition through `in_progress` first    |
| Marking parent done with incomplete subtasks | Inconsistent state                  | Check `list_subtasks` before marking parent done |
| Not calling `get_my_task` first              | Miss context, subtasks, prior notes | Always start with `get_my_task`                  |

## Task Creation

| Mistake                            | What happens                               | Fix                                                       |
| ---------------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| Missing `projectId` on tasks       | Agent works in `/tmp`, can't find codebase | Always pass `projectId` from `list_projects`              |
| Creating tasks without description | Next agent lacks context                   | Always include clear description with acceptance criteria |
| Forgetting `assignee` on subtasks  | Tasks sit unassigned                       | Set assignee when creating, or use `assign_task` after    |

## Permission Modes

| Mistake                               | What happens                  | Fix                             |
| ------------------------------------- | ----------------------------- | ------------------------------- |
| `acceptEdits` for MCP-using agents    | Agent hangs on MCP tool calls | Use `bypassPermissions` instead |
| `acceptEdits` for agents needing bash | Agent hangs on shell commands | Use `bypassPermissions` instead |

## Progress Tracking

| Mistake                         | What happens                   | Fix                                                   |
| ------------------------------- | ------------------------------ | ----------------------------------------------------- |
| Progress notes for every action | Noisy, unhelpful history       | Report at meaningful checkpoints only                 |
| No progress notes at all        | Orchestrator has no visibility | Add notes at phase transitions, blockers, completions |

## Working Directory

| Mistake                | What happens                  | Fix                                             |
| ---------------------- | ----------------------------- | ----------------------------------------------- |
| No `projectId` on task | Agent starts in `/tmp`        | Always link tasks to a project                  |
| Wrong `projectId`      | Agent works in wrong codebase | Verify with `get_project` before creating tasks |
