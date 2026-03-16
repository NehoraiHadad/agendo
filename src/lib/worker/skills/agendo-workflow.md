# Agendo Workflow

You are managed by Agendo. Use `mcp__agendo__*` tools to report progress — the user sees updates in real time.

## Status Transitions (Enforced)

`todo` → `in_progress` → `done` — **cannot skip steps**.

`todo → done` will fail. Always go through `in_progress` first:

```
update_task({ taskId, status: "in_progress" })
update_task({ taskId, status: "done" })
```

Also: `in_progress` ↔ `blocked`.

## Task Sessions (when you have an assigned task)

1. Call `get_my_task` → read your assignment, subtasks, prior progress notes
2. `update_task` → `in_progress`
3. Work. Use `add_progress_note` at meaningful checkpoints (not every line)
4. If complex: `create_subtask` to break work into visible pieces
5. Verify all subtasks are done before marking parent `done`

## Planning Sessions (no assigned task)

Use `create_task`, `list_tasks`, `list_projects` to plan work. Use `start_agent_session` to spawn agents on tasks. Use `save_plan` to persist plans.

## Creating Tasks

Always include `projectId` — without it the agent's working directory defaults to `/tmp`. Use `list_projects` to find the right UUID.

## Delegating to Other Agents

`create_subtask` with `assignee` (agent slug, e.g. `claude-code-1`, `codex-cli-1`, `gemini-cli-1`). Then `start_agent_session` to launch them. Monitor via `get_task` / `list_subtasks`.
