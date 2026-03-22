# Permission Modes

Permission modes control what an agent can do autonomously vs. what requires human approval.

## Mode Reference

| Mode                | Approves                         | Blocks                           | Use when                                                                                        |
| ------------------- | -------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bypassPermissions` | Everything (bash, MCP, file ops) | Nothing                          | **Default for autonomous agents.** Required when agents need MCP tools or shell commands.       |
| `acceptEdits`       | File Read/Write/Edit only        | Bash, MCP tool calls             | Agent only needs to read/write files. **Do NOT use if agent needs MCP updates or build steps.** |
| `default`           | Nothing auto-approved            | Everything (interactive prompts) | Human-supervised sessions only.                                                                 |
| `plan`              | Read-only tools                  | All writes                       | Planning/analysis sessions — agent can explore but not modify.                                  |

## Common Pitfall: acceptEdits + MCP

Using `acceptEdits` for agents that need to call `mcp__agendo__update_task` or run `pnpm build` causes them to **hang waiting for approval that never comes**. The agent pauses at each MCP tool call or bash command, but there's no human watching to approve.

**Rule of thumb**: if the agent needs MCP tools or shell commands, use `bypassPermissions`.

## When to Use Each Mode

### bypassPermissions (default)

- Autonomous task execution
- Any agent that needs to run builds, tests, or shell commands
- Any agent that needs to call MCP tools (`update_task`, `add_progress_note`, etc.)
- Multi-agent orchestration (sub-agents must be autonomous)

### acceptEdits

- Simple file editing tasks with no build step
- Code formatting or linting fixes
- Tasks where the agent only reads and writes files

### default

- Human-in-the-loop sessions
- Reviewing agent's work interactively
- Debugging sessions where you want to approve each step

### plan

- Architecture exploration
- Codebase analysis
- Planning sessions where the agent should not modify anything
- Investigation sessions (read-only)

## Changing Permission Mode Mid-Session

Permission mode can be changed on a live session via the control channel:

```
POST /api/sessions/{sessionId}/control
{ "type": "tool-approval", "postApprovalMode": "bypassPermissions" }
```

This is typically used after plan mode → implementation mode transitions (ExitPlanMode flow).
