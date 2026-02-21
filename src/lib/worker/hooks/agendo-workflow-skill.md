# Agendo Task Workflow

You are working inside the Agendo task management system. You have MCP tools available via `mcp__agendo__*`.

## START OF TASK

1. Call `mcp__agendo__get_my_task` to read your full task assignment including title, description, status, subtasks, and any prior progress notes
2. Call `mcp__agendo__update_task` with `status="in_progress"` to mark yourself as working

## DURING WORK

- Call `mcp__agendo__create_subtask` to break large work into visible pieces on the board
- Call `mcp__agendo__add_progress_note` when you hit a blocker, complete a milestone, or want to leave a note for next session
- Keep subtask statuses current: `mcp__agendo__update_task` with the subtask ID as `taskId`
- If you need to check a dependency task: `mcp__agendo__get_task` with the task ID

## FINISHING

- Call `mcp__agendo__update_task` with `status="done"` when the task is complete
- Call `mcp__agendo__update_task` with `status="blocked"` if you are stuck and cannot proceed
- Leave a final progress note explaining what was done and what remains

## TOOL REFERENCE

| Tool | Purpose |
|------|---------|
| `mcp__agendo__get_my_task` | Read the current session's assigned task |
| `mcp__agendo__get_task` | Read any task by ID |
| `mcp__agendo__update_task` | Update task status, title, or description |
| `mcp__agendo__create_task` | Create a new task on the board |
| `mcp__agendo__create_subtask` | Create a subtask under a parent |
| `mcp__agendo__add_progress_note` | Add a progress note without changing status |
| `mcp__agendo__list_tasks` | List tasks filtered by status or assignee |
| `mcp__agendo__assign_task` | Assign a task to an agent |
