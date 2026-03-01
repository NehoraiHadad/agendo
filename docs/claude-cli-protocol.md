# Claude Code CLI — Protocol & Integration Guide

> Source: Binary analysis of Claude Code CLI v2.1.62
> Binary path: `/home/ubuntu/.local/share/claude/versions/2.1.62`
> Last updated: 2026-02-27

This document describes how the Claude Code CLI works internally, based on reverse-engineering
the compiled binary. It serves as the source of truth for building agendo's integration layer
with the Claude CLI's `--permission-prompt-tool stdio` protocol.

---

## Table of Contents

1. [Binary Analysis Techniques](#1-binary-analysis-techniques)
2. [The stdio Protocol](#2-the-stdio-protocol)
3. [ExitPlanMode — Full Behavior](#3-exitplanmode--full-behavior)
4. [EnterPlanMode — Full Behavior](#4-enterplanmode--full-behavior)
5. [Permission Modes & Side Effects](#5-permission-modes--side-effects)
6. [Agendo Implementation Strategy](#6-agendo-implementation-strategy)
7. [Known Limitations & Workarounds](#7-known-limitations--workarounds)

---

## 1. Binary Analysis Techniques

The Claude Code binary is a Bun-compiled single executable (~228MB). Despite compilation,
all JavaScript source is embedded as searchable strings.

### Finding Code

```bash
# Search for strings
strings /home/ubuntu/.local/share/claude/versions/2.1.62 | grep 'PATTERN'

# Find byte offset of a string
grep -oba 'SEARCH_TERM' /home/ubuntu/.local/share/claude/versions/2.1.62

# Extract readable code at a specific byte offset (adjust skip & count)
dd if=/home/ubuntu/.local/share/claude/versions/2.1.62 \
   bs=1 skip=113820000 count=5000 2>/dev/null | \
   tr '\0' '\n' | tr -cd '[:print:]\n'
```

### Useful Search Terms

| Term                                  | What it finds                                        |
| ------------------------------------- | ---------------------------------------------------- |
| `control_request`, `control_response` | stdio protocol message handling                      |
| `can_use_tool`                        | Tool approval flow                                   |
| `set_permission_mode`                 | In-place mode switching                              |
| `permissionPromptTool`                | The `--permission-prompt-tool` handler class (`ArH`) |
| `onAllow`, `onReject`                 | TUI permission prompt callbacks                      |
| `ExitPlanMode`, `EnterPlanMode`       | Plan mode tool handlers                              |
| `clearContext`                        | Context clearing mechanism                           |
| `th$`                                 | Side effects builder for plan mode exit              |
| `$rH`                                 | Zod schema for allow/deny responses                  |
| `tengu_plan_exit`                     | Analytics event (contains option values)             |

### Key Byte Offsets (v2.1.62)

| Offset     | Content                                                            |
| ---------- | ------------------------------------------------------------------ |
| ~113820000 | ExitPlanMode handler (`M4B` function) + `th$` side effects builder |
| ~113627000 | `permissionPromptTool` handler class + stdin reader (`ArH`)        |
| ~113003000 | `permissionPromptTool` config references                           |

> These offsets change between versions. Use `grep -oba` to find current offsets.

---

## 2. The stdio Protocol

When launched with `--permission-prompt-tool stdio`, the CLI communicates via JSON lines
on stdin/stdout.

### Messages: CLI → External Tool (stdout)

#### Tool Approval Request

```json
{
  "type": "control_request",
  "request_id": "9472f688-...",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "ExitPlanMode",
    "input": { "allowedPrompts": [{ "tool": "Bash", "prompt": "run tests" }] },
    "tool_use_id": "toolu_01Nf..."
  }
}
```

Also emitted: `stream_event`, `assistant`, `user` (tool results), `system` (init/compact).

### Messages: External Tool → CLI (stdin)

#### Allow Response

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "9472f688-...",
    "response": {
      "behavior": "allow",
      "updatedInput": {},
      "updatedPermissions": [],
      "toolUseID": "toolu_01Nf..."
    }
  }
}
```

#### Deny Response

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "9472f688-...",
    "response": {
      "behavior": "deny",
      "message": "User requested changes to the plan",
      "interrupt": false,
      "toolUseID": "toolu_01Nf..."
    }
  }
}
```

#### Control Request (external → CLI)

The external tool can also send requests TO the CLI:

```json
{
  "type": "control_request",
  "request_id": "ctrl-...",
  "request": {
    "subtype": "set_permission_mode",
    "mode": "acceptEdits"
  }
}
```

Other external→CLI subtypes: `mcp_message`, `hook_callback`

#### Other stdin messages

```json
{"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "..."}]}}
{"type": "keep_alive"}
{"type": "update_environment_variables", "variables": {"KEY": "VALUE"}}
```

### Response Schemas (Zod, from CLI source)

```typescript
// Allow
const AllowSchema = z.object({
  behavior: z.literal('allow'),
  updatedInput: z.record(z.string(), z.unknown()), // modified tool input
  updatedPermissions: z.array(PermissionUpdate).optional(), // rule changes
  toolUseID: z.string().optional(),
});

// Deny
const DenySchema = z.object({
  behavior: z.literal('deny'),
  message: z.string(), // reason text
  interrupt: z.boolean().optional(), // abort conversation
  toolUseID: z.string().optional(),
});
```

### `updatedPermissions` Format

Supports rule management (NOT mode changes):

```typescript
type PermissionUpdate =
  | {
      type: 'addRules';
      rules: Rule[];
      behavior: 'allow' | 'deny';
      destination: 'session' | 'localSettings';
    }
  | { type: 'replaceRules'; rules: Rule[]; behavior: string; destination: string }
  | { type: 'removeRules'; rules: Rule[]; behavior: string; destination: string }
  | { type: 'addDirectories'; directories: string[]; destination: string }
  | { type: 'removeDirectories'; directories: string[]; destination: string };
```

> **`setMode` is NOT supported via `updatedPermissions`**. Mode changes in the TUI
> are handled via internal side effects, not through the stdio protocol. For external
> tools, use the `set_permission_mode` control_request instead.

---

## 3. ExitPlanMode — Full Behavior

### Tool Input Schema

```json
{
  "allowedPrompts": [
    { "tool": "Bash", "prompt": "run database migrations" },
    { "tool": "Bash", "prompt": "run tests" }
  ]
}
```

The `allowedPrompts` field lists the permissions the agent requested when exiting plan mode.

### TUI Options (4 choices)

The CLI shows different labels depending on `isBypassPermissionsModeAvailable`:

#### Option 1 — Clear Context

| Condition            | Label                                                            | Value                    |
| -------------------- | ---------------------------------------------------------------- | ------------------------ |
| Bypass available     | `Yes, clear context (X% used) and bypass permissions`            | `yes-bypass-permissions` |
| Bypass NOT available | `Yes, clear context (X% used) and auto-accept edits (shift+tab)` | `yes-accept-edits`       |

**CLI handler:**

```javascript
// 1. Deny the ExitPlanMode tool
H.onReject();

// 2. Create new conversation with plan injected (TUI-internal)
D((t) => ({
  ...t,
  initialMessage: {
    message: o$({ content: `Implement the following plan:\n\n${planContent}` }),
    planContent: planContent,
    clearContext: true, // ← discard entire conversation history
    mode: 'acceptEdits', // ← new permission mode
    allowedPrompts: allowedPrompts,
  },
}));
```

This is the **most radical** option: the entire conversation is discarded and a fresh one
starts with only the plan as context.

#### Option 2 — Keep Context, Auto-Accept

| Condition            | Label                         | Value                           |
| -------------------- | ----------------------------- | ------------------------------- |
| Bypass available     | `Yes, and bypass permissions` | `yes-accept-edits-keep-context` |
| Bypass NOT available | `Yes, auto-accept edits`      | `yes-accept-edits-keep-context` |

**CLI handler:**

```javascript
// Allow the tool with side effects
H.onAllow(
  { plan: planContent }, // updatedInput
  [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    // + optional addRules for allowedPrompts
  ],
);
```

#### Option 3 — Keep Context, Manual Approval

Label: `Yes, manually approve edits` | Value: `yes-default-keep-context`

**CLI handler:**

```javascript
H.onAllow({ plan: planContent }, [{ type: 'setMode', mode: 'default', destination: 'session' }]);
```

#### Option 4 — Feedback (Deny)

Label: `No, keep planning` | Value: `no`
Placeholder: `Type here to tell Claude what to change`

**CLI handler:**

```javascript
// Only fires if feedback text is non-empty or images are attached
H.onReject(feedbackText, images);
```

Supports image pasting via the TUI's `onImagePaste` callback.

### No-Plan Fallback

If no plan file was found, a simpler 2-option dialog is shown:

- "Yes" → `onAllow({}, [{type: "setMode", mode: "default", destination: "session"}])`
- "No" → `onReject()`

### Side Effects Builder (`th$` function)

```javascript
function th$(mode, allowedPrompts) {
  const effects = [{ type: 'setMode', mode: normalizeMode(mode), destination: 'session' }];
  if (allowedPrompts?.length > 0) {
    effects.push({
      type: 'addRules',
      rules: allowedPrompts.map((p) => ({
        toolName: p.tool,
        ruleContent: formatPromptRule(p.prompt),
      })),
      behavior: 'allow',
      destination: 'session',
    });
  }
  return effects;
}
```

### Keyboard Shortcuts

- `shift+tab` — Immediately triggers option 1 (`yes-accept-edits`)
- `ctrl+g` — Open plan in external `$EDITOR`

---

## 4. EnterPlanMode — Full Behavior

### TUI Options (2 choices)

- **"Yes, enter plan mode"** → `onAllow({}, [{type: "setMode", mode: "plan", destination: "session"}])`
- **"No, start implementing now"** → `onReject()`

In agendo, EnterPlanMode is also in `APPROVAL_GATED_TOOLS` but currently uses the generic
approval card (2 buttons). Could be upgraded to match the CLI labels.

---

## 5. Permission Modes & Side Effects

### Mode Change via control_request

```json
{
  "type": "control_request",
  "request_id": "ctrl-...",
  "request": {
    "subtype": "set_permission_mode",
    "mode": "acceptEdits"
  }
}
```

The CLI responds with a `control_response` on stdout. Agendo's `sendControlRequest` method
in `claude-adapter.ts` handles this with a 5-second timeout.

### Mode Labels (from CLI source)

| Mode                | CLI Label                                                 |
| ------------------- | --------------------------------------------------------- |
| `plan`              | Plan — agent presents a plan before executing             |
| `default`           | Approve — each tool requires your approval                |
| `acceptEdits`       | Edit Only — file edits auto-approved, bash needs approval |
| `bypassPermissions` | Auto — all tools auto-approved                            |
| `dontAsk`           | Auto — all tools auto-approved                            |

### Timing Considerations

When sending mode changes AFTER a tool approval:

- The `control_response` (allow/deny) must reach the CLI **before** the
  `set_permission_mode` control_request
- Claude processes stdin messages sequentially in its main loop
- A 500ms delay between allow response and mode change is sufficient
- A 2000ms delay for `/compact` after mode change ensures both settle

---

## 6. Agendo Implementation Strategy

### How Agendo Maps CLI Options

| CLI Option                            | Protocol Response               | Agendo Side Effects                                                                |
| ------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| Option 1: Clear context + auto-accept | **Deny** + fresh conversation   | Kill process → clear sessionRef → re-enqueue with plan as initialPrompt + new mode |
| Option 2: Auto-accept edits           | **Allow** + setMode side effect | Allow → 500ms delay → `set_permission_mode` control_request                        |
| Option 3: Manually approve            | **Allow** + setMode("default")  | Allow → 500ms delay → `set_permission_mode` control_request                        |
| Option 4: Feedback                    | **Deny** + feedback text        | Deny → send feedback as user message                                               |

### Option 1 — Identical to CLI (Recommended Implementation)

The CLI denies the tool and starts a completely new conversation. We can replicate this:

```
1. Resolve approval as 'deny'
2. Read plan content from agent's working directory (plan file)
3. Kill the process (terminateKilled=true)
4. Update DB: permissionMode → acceptEdits, sessionRef → null
5. Re-enqueue session with initialPrompt = "Implement the following plan:\n\n{plan}"
6. New process starts via adapter.spawn() (not resume) → fresh context
```

Key: clearing `sessionRef` in DB causes `session-process.start()` to call `spawn()`
instead of `resume()`, starting a brand new Claude conversation.

### Options 2 & 3 — In-Place Mode Change

```
1. Resolve approval as 'allow'
2. Wait 500ms (let allow response reach Claude)
3. Send set_permission_mode control_request
4. Claude processes mode change in its main loop
```

### Option 4 — Deny with Feedback

```
1. Resolve approval as 'deny'
2. Send feedback text as a user message via adapter.sendMessage()
   (or via /message API route for cold-resume support)
```

### Adapter Response Format

Current adapter code in `handleToolApprovalRequest`:

```typescript
const response: Record<string, unknown> = { subtype: outcome };
if (typeof decision === 'object' && decision.updatedInput) {
  response.updatedInput = decision.updatedInput;
}
stdin.write(
  JSON.stringify({
    request_id: requestId,
    type: 'control_response',
    response,
  }) + '\n',
);
```

Note: The adapter wraps the response in `{ subtype: "allow"|"deny" }` format, while
the Zod schema expects `{ behavior: "allow"|"deny" }`. The CLI accepts both (the
`subtype` key was the original format, `behavior` is the newer Zod-validated format).

> **TODO**: Verify if `subtype` is still accepted or if we should switch to `behavior`.

---

## 7. Plan File Storage

### Directory & Naming

Claude Code stores plan files in `{cwd}/.claude/plans/`. The filename is a random hash
(`{hash}.md`) generated per conversation via the `Cd(y$())` function chain. Sub-agents
get their own file: `{hash}-agent-{agentId}.md`.

```javascript
// Simplified from binary (z6, T6, Cd functions)
function planFilePath(agentId) {
  const dir = plansDirectory ?? join(claudeDir, 'plans');
  const hash = generateOrRetrieveHash(conversationId);
  if (agentId) return join(dir, `${hash}-agent-${agentId}.md`);
  return join(dir, `${hash}.md`);
}
```

### Reading Plan Content

The `WK()` function reads plan content — returns `null` if the file doesn't exist:

```javascript
function readPlanContent(agentId) {
  const path = planFilePath(agentId);
  if (!fs.existsSync(path)) return null;
  return fs.readFileSync(path, 'utf-8');
}
```

### Agendo's Approach

Since plan filenames are random hashes internal to the CLI, agendo reads the most recently
modified `.md` file from `{session.cwd}/.claude/plans/` when clearContextRestart fires.
This works because the ExitPlanMode tool is called immediately after the plan is written.

Fallback: if no plan file is found, uses a generic prompt:
`"Continue implementing the plan from the previous conversation."`

---

## 8. Known Limitations & Workarounds

### Context Clearing

The `clearContext: true` mechanism is TUI-internal — it's not part of the stdio protocol.
Agendo replicates it by killing the process and starting a new one without `--resume`.

**Agendo implementation (2026-02-27):**

1. Frontend sends `clearContextRestart: true` in the tool-approval control message
2. Worker denies the ExitPlanMode tool (resolver('deny'))
3. Worker reads plan from `{cwd}/.claude/plans/` (most recent .md)
4. Worker updates DB: `sessionRef = null`, `initialPrompt = "Implement..."`, `permissionMode`
5. Worker kills the process (`terminateKilled = true`)
6. `onExit()` re-enqueues WITHOUT `resumeRef` → `session-runner` calls `spawn()` (fresh)
7. New Claude process starts with clean context + plan as initial prompt

### Plan Content Access

The CLI reads plan content from its internal plan file path. Plans are stored in the
**global** Claude config directory at `~/.claude/plans/{hash}.md` (NOT project-local).
The hash-to-session mapping is in an in-memory map (`ILH()`), not persisted to disk.

**Agendo strategy (two-tier):**

1. **Eager capture**: When ExitPlanMode fires (session active), the worker reads the most
   recently modified `.md` from `~/.claude/plans/` and caches it at
   `/tmp/agendo-plan-{sessionId}.json`. This is reliable because the plan was just written.
2. **Cached read**: When clearContextRestart fires (active or idle), read from the cache
   first, then fall back to the most recent file in `~/.claude/plans/`.

### Side Effects in Protocol

`setMode` and `addRules` are TUI side effects, not protocol features. Agendo handles
them via separate `control_request` messages sent after the tool response.

### Stale Approval Cards

When a session goes idle (process exits) while an ExitPlanMode card is displayed:

- Options 1-3 require an active process to send the control_response
- Option 4 (feedback) works for idle sessions via the `/message` cold-resume route
- The UI shows a warning when the session is not active

### `interrupt: true` in Deny Response

Setting `interrupt: true` in a deny response causes the CLI to abort its current
conversation loop (`abortController.abort()`). This could be useful for forcefully
stopping an agent, but is currently not used by agendo.

---

## 9. Key Insights for Future Agendo Improvements

### Protocol vs TUI Split

The Claude Code CLI has two distinct layers:

1. **stdio protocol** — JSON-line messages on stdin/stdout (`control_request`/`control_response`)
2. **TUI side effects** — internal React state changes that are NOT exposed via the protocol

Features like `setMode`, `clearContext`, `addRules` are TUI-only. Agendo must replicate
them using protocol primitives:

- `setMode` → separate `set_permission_mode` control_request (with timing delay)
- `clearContext` → kill process + spawn new (without `--resume`)
- `addRules` → `updatedPermissions` in allow response (supported in protocol)

### Binary Analysis Tips

- **Version tracking**: offsets change between versions. Always re-find with `grep -oba`.
  Current binary: `/home/ubuntu/.local/share/claude/versions/{version}`.
- **Key functions to find**: `permissionPromptTool`/`ArH` (protocol handler), `th$` (side effects),
  `z6`/`T6`/`Cd` (plan files), `M4B` (ExitPlanMode renderer), `vCH` (response processor).
- **Zod schemas**: search for `z.literal("allow")` or `z.literal("deny")` to find response schemas.
- **Analytics events**: search for `tengu_` prefix to find option values and flow names.

### Undocumented Protocol Features Worth Exploring

| Feature                         | Search Term                    | Status                                |
| ------------------------------- | ------------------------------ | ------------------------------------- |
| `mcp_message` control_request   | `mcp_message`                  | External→CLI, for MCP tool forwarding |
| `hook_callback` control_request | `hook_callback`                | External→CLI, for hook results        |
| `interrupt` control_request     | `subtype.*interrupt`           | External→CLI, soft interrupt          |
| `update_environment_variables`  | `update_environment_variables` | External→CLI, live env update         |
| `keep_alive`                    | `keep_alive`                   | External→CLI, heartbeat               |

### Spawn vs Resume Mechanism

Claude Code's `--resume {sessionId}` flag restores a previous conversation. Agendo
controls this via the `sessionRef` DB field:

- **Resume**: `sessionRef` set → passed as `--resume` flag → conversation continues
- **Fresh spawn**: `sessionRef` null → no `--resume` flag → new conversation starts

The `session-runner.ts` decides: `resumeRef ?? session.sessionRef ?? undefined`. If both
are falsy, `adapter.spawn()` is called instead of `adapter.resume()`.

### Permission Mode Timing

When changing modes after a tool approval (ExitPlanMode options 2/3):

1. Send `control_response` (allow) first
2. Wait 500ms for it to reach Claude's stdin reader
3. Send `set_permission_mode` control_request
4. If also compacting: wait 2000ms total, then send `/compact` as a user message

This sequential timing is critical — sending both simultaneously causes the mode change
to race with the tool response processing.
