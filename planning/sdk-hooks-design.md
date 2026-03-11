# SDK Hooks Design

## Overview

The Claude Agent SDK supports `Options.hooks` for TypeScript hook callbacks that run **in-process** (in the worker) instead of shell scripts in `.claude/hooks/`. This gives Agendo full programmatic control over agent behavior with type safety and access to application state.

## Available HookEvent Types

The SDK defines 21 hook events:

| Event                | Fires When                 | Key Input Fields                         |
| -------------------- | -------------------------- | ---------------------------------------- |
| `PreToolUse`         | Before a tool executes     | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse`        | After a tool succeeds      | `tool_name`, `tool_input`, `tool_result` |
| `PostToolUseFailure` | After a tool fails         | `tool_name`, `tool_input`, `error`       |
| `Notification`       | Agent emits a notification | `message`                                |
| `UserPromptSubmit`   | User sends a message       | `prompt`                                 |
| `SessionStart`       | Session begins             | (base fields only)                       |
| `SessionEnd`         | Session ends               | (base fields only)                       |
| `Stop`               | Agent stops                | (base fields only)                       |
| `SubagentStart`      | Subagent spawns            | (agent context)                          |
| `SubagentStop`       | Subagent finishes          | (agent context)                          |
| `PreCompact`         | Before context compaction  | (base fields only)                       |
| `PermissionRequest`  | Permission check triggered | (permission context)                     |
| `Setup`              | Initial setup phase        | (base fields only)                       |
| `TeammateIdle`       | Teammate becomes idle      | (teammate context)                       |
| `TaskCompleted`      | A task completes           | `task_id`, `task_subject`                |
| `Elicitation`        | MCP elicitation request    | (elicitation context)                    |
| `ElicitationResult`  | Elicitation response       | (elicitation context)                    |
| `ConfigChange`       | Config is modified         | (config context)                         |
| `WorktreeCreate`     | Worktree created           | `name`                                   |
| `WorktreeRemove`     | Worktree removed           | `worktree_path`                          |
| `InstructionsLoaded` | CLAUDE.md loaded           | `file_path`, `memory_type`               |

### BaseHookInput (common to all events)

```typescript
{
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  agent_id?: string;      // present when in a subagent
  agent_type?: string;     // agent type name
}
```

## Hook Callback Structure

```typescript
// HookCallbackMatcher — groups hooks with an optional tool name matcher
{
  matcher?: string;           // tool name pattern (for PreToolUse/PostToolUse)
  hooks: HookCallback[];      // array of async callbacks
  timeout?: number;            // seconds before timeout
}

// HookCallback signature
type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;

// Return type — sync form
type SyncHookJSONOutput = {
  continue?: boolean;          // true = proceed normally
  suppressOutput?: boolean;    // hide output from agent
  stopReason?: string;         // stop execution with reason
  decision?: 'approve' | 'block';
  systemMessage?: string;      // inject a system message
  reason?: string;
  hookSpecificOutput?: /* event-specific output union */;
};

// Return type — async form (for long-running hooks)
type AsyncHookJSONOutput = {
  async: true;
  asyncTimeout?: number;
};
```

### PreToolUse Hook-Specific Output

```typescript
type PreToolUseHookSpecificOutput = {
  hookEventName: 'PreToolUse';
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>; // modify tool input before execution
  additionalContext?: string; // inject context for the agent
};
```

## How Hooks Could Be Used in Agendo

### 1. Audit Logging (PostToolUse)

Log every tool execution to the session's event stream for observability:

```typescript
sdkHooks: {
  PostToolUse: [
    {
      hooks: [
        async (input) => {
          const { tool_name, tool_input } = input as PostToolUseHookInput;
          await auditLog.write({ tool_name, tool_input, sessionId: input.session_id });
          return { continue: true };
        },
      ],
    },
  ];
}
```

### 2. Command Blocking (PreToolUse)

Block dangerous Bash commands (e.g., `rm -rf /`, `DROP TABLE`):

```typescript
sdkHooks: {
  PreToolUse: [
    {
      matcher: 'Bash',
      hooks: [
        async (input) => {
          const { tool_input } = input as PreToolUseHookInput;
          const cmd = String(tool_input.command ?? '');
          if (DANGEROUS_PATTERNS.some((p) => p.test(cmd))) {
            return {
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Blocked by Agendo safety policy',
              },
            };
          }
          return { continue: true };
        },
      ],
    },
  ];
}
```

### 3. Push Notifications on Tool Results (PostToolUse)

Send push notifications when specific tools complete (e.g., test runs):

```typescript
sdkHooks: {
  PostToolUse: [
    {
      matcher: 'Bash',
      hooks: [
        async (input) => {
          const { tool_input } = input as PostToolUseHookInput;
          const cmd = String(tool_input.command ?? '');
          if (cmd.includes('npm test') || cmd.includes('pnpm test')) {
            await sendPushToAll(`Tests completed in session ${input.session_id}`);
          }
          return { continue: true };
        },
      ],
    },
  ];
}
```

### 4. Task Progress Tracking (PostToolUse)

Automatically add progress notes when agents make file changes:

```typescript
sdkHooks: {
  PostToolUse: [
    {
      matcher: 'Edit',
      hooks: [
        async (input) => {
          const { tool_input } = input as PostToolUseHookInput;
          const filePath = String(tool_input.file_path ?? '');
          await addProgressNote(taskId, `Edited ${filePath}`);
          return { continue: true };
        },
      ],
    },
  ];
}
```

### 5. Session End Notifications (SessionEnd)

```typescript
sdkHooks: {
  SessionEnd: [
    {
      hooks: [
        async (input) => {
          await notifySessionEnded(input.session_id);
          return { continue: true };
        },
      ],
    },
  ];
}
```

## Integration with Existing canUseTool Permission System

SDK hooks and `canUseTool` operate at **different layers**:

| Aspect                 | `canUseTool`                    | `PreToolUse` hooks                      |
| ---------------------- | ------------------------------- | --------------------------------------- |
| **Purpose**            | Permission gating (allow/deny)  | Behavior modification + gating          |
| **Scope**              | Binary allow/deny per tool      | Can modify input, inject context, block |
| **Timing**             | Called by SDK permission system | Fires before `canUseTool`               |
| **Agendo integration** | Routes to `approval-handler.ts` | Would be configured per-session         |
| **Multi-layer**        | Single callback                 | Multiple hooks in chain                 |

**Key insight**: `PreToolUse` hooks fire **before** `canUseTool`. A hook can:

- Return `permissionDecision: 'deny'` to block before `canUseTool` is ever called
- Return `permissionDecision: 'allow'` to auto-approve before `canUseTool`
- Return `permissionDecision: 'ask'` to defer to the normal `canUseTool` flow
- Modify `updatedInput` to sanitize tool input before execution

**Recommended approach**: Keep `canUseTool` for interactive user-facing approval (the UI flow). Use `PreToolUse` hooks for automated policy enforcement that doesn't need user interaction.

## Current Implementation

The passthrough is implemented in:

- `SpawnOpts.sdkHooks` in `types.ts` — accepts hook config
- `buildSdkOptions()` in `build-sdk-options.ts` — passes `hooks` to SDK `Options`

Hooks are defined at the SpawnOpts level, meaning they can be configured per-session from `session-runner.ts` based on capability settings, task requirements, or project policies.

## Future Work

1. **Hook registry** — Define reusable hook factories in a `hooks/` directory (e.g., `createAuditHook()`, `createSafetyHook()`)
2. **Capability-level hooks** — Allow capabilities to declare hooks in their config
3. **Project-level policies** — Projects could define safety hooks that apply to all sessions
4. **Hook metrics** — Track hook execution time and block rates for observability
