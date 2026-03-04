# Cross-Agent Plan Mode: Research Findings & Design

> Date: 2026-03-04
> Status: Research complete, design proposed
> Task: 6c575c5c-56a6-4bb3-be01-0e312c6208cf

## Executive Summary

Agendo's plan mode is currently Claude-specific. This document captures detailed research
on Codex and Gemini CLI plan capabilities, identifies 7 gaps in the current implementation,
and proposes a **tiered capture strategy** (agent-native → MCP fallback → stream parsing)
with concrete implementation steps.

> **CRITICAL UPDATE (2026-03-04, round 2)**: The Codex integration mode itself is wrong.
> Agendo uses `codex exec` (spawn per turn), but Codex has `codex app-server` — a persistent
> JSON-RPC bidirectional server that VS Code, macOS app, JetBrains, and Xcode all use.
> Migrating to `app-server` would fix plan mode AND many other limitations simultaneously.
> See **Addendum: CLI Integration Mode Findings** at the bottom of this document.

---

## 1. Current State (Claude)

Claude's plan mode is the gold standard — fully integrated end-to-end:

```
User → plan-service.startPlanConversation()
  → session(kind='conversation', permissionMode='plan')
  → claude-adapter: --permission-mode plan (read-only)
  → Claude explores codebase, writes plan
  → Claude calls ExitPlanMode tool
  → approval-handler: capturePlanFilePath() → ~/.claude/plans/xxx.md
  → session.kind === 'conversation'? → auto-deny, savePlanFromSession()
  → Plan content saved to plans table, status='ready'
  → Editor auto-refreshes (5s polling)
```

**Key files**: `session-plan-utils.ts`, `approval-handler.ts` (lines 199-216), `plan-service.ts`

---

## 2. Codex CLI Plan Capabilities

### What exists

| Feature                        | Status            | Details                                                                    |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------- |
| `--sandbox read-only`          | Working           | CAN read all files, CANNOT write or execute. Used by Agendo for plan mode. |
| Plan Mode (TUI)                | Interactive only  | Via `/collab` command. Uses `<proposed_plan>` XML tags in agent text.      |
| `update_plan` tool             | Default mode only | Separate concept — TODO/checklist tracker, NOT plan mode.                  |
| Plan files on disk             | NO                | Plans live only in JSONL session files and stdout.                         |
| `--output-last-message <FILE>` | Available         | Can write final agent message to a file.                                   |

### Critical findings

1. **No plan mode in non-interactive `codex exec`**. The `/collab plan` command is TUI-only.
   `--sandbox read-only` provides the filesystem enforcement but the agent doesn't receive
   Plan Mode system prompt instructions or emit `<proposed_plan>` tags.

2. **Plan content via XML tags**: In TUI plan mode, Codex wraps plans in
   `<proposed_plan>...</proposed_plan>` tags within `agent_message` text. The TUI
   parses these and renders approve/reject buttons. In `--json` mode, these tags appear
   within `item.completed` events of type `agent_message`.

3. **`update_plan` tool is NOT plan mode**: It's a progress tracker that emits `plan_update`
   and `plan_delta` JSONL events. Agendo's `codex-event-mapper.ts` does NOT handle these.

4. **Resume loses read-only**: `codex exec resume` does NOT accept `--sandbox`, falling back
   to `--full-auto` (workspace-write + on-request approval). **This is a gap.**

5. **Collaboration modes** (from binary analysis): `default`, `plan`, `PairProgramming`,
   `execute`, `custom`. The `turn_context` event reveals the active `collaboration_mode_kind`.

### Sandbox enforcement details

| Mode                 | Read     | Write      | Execute         | Network      |
| -------------------- | -------- | ---------- | --------------- | ------------ |
| `read-only`          | Anywhere | NO         | NO              | NO           |
| `workspace-write`    | Anywhere | cwd + /tmp | Yes (sandboxed) | NO (default) |
| `danger-full-access` | Anywhere | Anywhere   | Yes             | Yes          |

Enforcement via Landlock (kernel >= 5.13) + seccomp on Linux.

---

## 3. Gemini CLI Plan Capabilities

### What exists

| Feature                | Status            | Details                                                       |
| ---------------------- | ----------------- | ------------------------------------------------------------- |
| `--approval-mode plan` | CLI flag exists   | Read-only mode. Whitelists read/search tools only.            |
| ACP plan mode          | NOT WORKING (yet) | `"plan"` rejected with -32603. PR #18891 may add support.     |
| `enter_plan_mode` tool | Native            | Switches agent into plan mode                                 |
| `exit_plan_mode` tool  | Native            | Presents plan for approval. Requires `plan_path` param.       |
| Plan files on disk     | YES               | Written to `~/.gemini/tmp/<project>/<session-id>/plans/`      |
| Model routing          | Native            | Pro model during planning → Flash model during implementation |
| `experimental.plan`    | Required          | Must be `true` in `~/.gemini/settings.json`                   |

### Critical findings

1. **Native plan mode exists** (`--approval-mode plan`) but requires:
   - `experimental.plan: true` in settings.json
   - NOT currently supported in ACP mode (the mode Agendo uses)
   - Recent PR #18891 may add conditional ACP plan support behind `isPlanEnabled` flag

2. **Agendo's adapter SKIPS plan mode**: `buildArgs()` does not map `plan` to
   `--approval-mode plan`. The `setPermissionMode()` method explicitly excludes `plan`
   from the ACP mode map. Gemini runs in `default` mode instead.

3. **Hybrid approach possible**: Pass BOTH `--experimental-acp` AND `--approval-mode plan`
   to set the initial mode. ACP manages runtime mode switches. **Needs testing.**

4. **Plan file path differs from Claude**: `~/.gemini/tmp/<project>/<session-id>/plans/`
   vs Claude's `~/.claude/plans/`. Custom path via `general.plan.directory` setting.

5. **`exit_plan_mode` differs from Claude's `ExitPlanMode`**:
   - Requires explicit `plan_path` parameter (Claude auto-detects)
   - Writes to different directory
   - No post-approval mode switching (Claude has 4 options)
   - Would appear as a regular tool call in ACP permission flow

6. **ACP mode IDs confirmed**: `"default"`, `"autoEdit"`, `"yolo"`. Plan mode conditionally
   available via `buildAvailableModes()` when `isPlanEnabled` is true.

### Settings required

```json
// ~/.gemini/settings.json
{
  "experimental": {
    "plan": true
  },
  "general": {
    "plan": {
      "modelRouting": true,
      "directory": ".gemini/plans" // optional custom path
    }
  }
}
```

---

## 4. Identified Gaps

### Gap 1: Plan capture is Claude-only

`session-plan-utils.ts` reads from `~/.claude/plans/`. No support for Gemini's
`~/.gemini/tmp/` path or Codex's text-based plans.

### Gap 2: No MCP plan tools

The MCP server has no `save_plan` tool. Agents can only interact with plans indirectly
(via task management tools during execution).

### Gap 3: Plan conversation prompt is Claude-specific

`startPlanConversation()` tells all agents to "use ExitPlanMode to finalize it" — meaningless
to Codex and Gemini.

### Gap 4: Codex resume loses read-only constraint

`codex exec resume` doesn't accept `--sandbox`, so resumed plan sessions run with full
permissions.

### Gap 5: Gemini adapter skips plan mode

`buildArgs()` doesn't pass `--approval-mode plan` to the CLI in ACP mode.

### Gap 6: Codex `plan_update`/`plan_delta` events not handled

The event mapper silently drops these JSONL events.

### Gap 7: No universal plan finalization signal

Claude has `ExitPlanMode`. Codex has `<proposed_plan>` tags. Gemini has `exit_plan_mode`.
Agendo only recognizes Claude's signal.

---

## 5. Recommended Strategy: Tiered Plan Capture

### Tier 1: Agent-native (where available) — highest fidelity

| Agent  | Mechanism                                     | Capture method                     |
| ------ | --------------------------------------------- | ---------------------------------- |
| Claude | `ExitPlanMode` → `~/.claude/plans/`           | Current flow. Keep as-is.          |
| Gemini | `exit_plan_mode` → `~/.gemini/tmp/.../plans/` | New: `captureGeminiPlanFilePath()` |

### Tier 2: MCP-based (universal fallback) — structured and reliable

Add a **`save_plan`** MCP tool that any agent can call to submit plan content:

```typescript
// MCP tool: save_plan
{
  name: 'save_plan',
  description: 'Save or update an implementation plan. Use this to submit your finalized plan.',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The full plan content in markdown' },
      title: { type: 'string', description: 'Plan title (extracted from first heading if omitted)' },
      planId: { type: 'string', description: 'Existing plan ID to update (omit for new plan)' },
    },
    required: ['content'],
  },
}
```

**Benefits**:

- Works for ALL agents (Claude, Codex, Gemini)
- Structured input — no parsing needed
- Agent calls it explicitly — no ambiguity about "is this the plan?"
- Works in all modes (ACP, stdio, sandbox read-only)

**Implementation**: The tool looks up the session → session.projectId → creates/updates plan.
If the session is linked to an existing plan (via `conversationSessionId`), updates that plan.

### Tier 3: Stream parsing (last resort) — fragile but functional

| Agent  | Signal                                                | Parsing                                        |
| ------ | ----------------------------------------------------- | ---------------------------------------------- |
| Codex  | `<proposed_plan>...</proposed_plan>` in agent_message | Regex on `agent:text` events                   |
| Gemini | Plain text output                                     | Not reliably distinguishable from conversation |

Only use if agent fails to call the MCP tool.

---

## 6. Implementation Plan

### Phase 1: MCP `save_plan` tool + agent-specific prompts

**Files to modify**:

1. **`src/lib/mcp/server.ts`** — Add `save_plan` tool
2. **`src/lib/services/plan-service.ts`** — Add `savePlanFromMcp()` helper, update
   `startPlanConversation()` with agent-specific prompts
3. **`src/lib/worker/adapters/gemini-adapter.ts`** — Add `--approval-mode plan` when
   `permissionMode === 'plan'` (test hybrid with `--experimental-acp`)

**Agent-specific prompts** for `startPlanConversation()`:

```
CLAUDE prompt (keep current):
  "...use ExitPlanMode to finalize it..."
  (plan captured via native file path)

CODEX prompt:
  "You are in read-only sandbox mode — you can read files but cannot write or execute.
   Explore the codebase, analyze the plan, and when ready, save your finalized plan
   using the mcp__agendo__save_plan tool with the full plan content in markdown.
   Do NOT try to write files or run commands — you are in read-only mode."

GEMINI prompt:
  "You are reviewing an implementation plan in plan mode — you can read the codebase
   but cannot write files. Explore the code to validate assumptions and identify gaps.
   When satisfied, save your finalized plan using the mcp__agendo__save_plan tool
   with the full plan content in markdown."
```

### Phase 2: Gemini native plan mode (test hybrid approach)

1. Update `gemini-adapter.ts` `buildArgs()` to include `--approval-mode plan` when
   `permissionMode === 'plan'`
2. Ensure `experimental.plan: true` in `~/.gemini/settings.json`
3. Test if `--experimental-acp` + `--approval-mode plan` work together
4. If it works: add `captureGeminiPlanFilePath()` to handle `exit_plan_mode` natively
5. If it doesn't: rely on MCP `save_plan` (Tier 2)

### Phase 3: Codex enhancements (optional)

1. Handle `plan_update`/`plan_delta` events in `codex-event-mapper.ts` (for `update_plan`
   tool visibility in the UI)
2. Consider parsing `<proposed_plan>` tags from Codex output as backup capture
3. Note: resume read-only loss is a Codex CLI limitation — monitor for upstream fix

---

## 7. Decision Matrix

| Approach                 | Codex                   | Gemini                | Claude                                   | Effort | Reliability |
| ------------------------ | ----------------------- | --------------------- | ---------------------------------------- | ------ | ----------- |
| Agent-native only        | No plan mode in exec    | Needs ACP testing     | Works                                    | Low    | Mixed       |
| MCP `save_plan` only     | Works                   | Works                 | Works (but loses native ExitPlanMode UX) | Medium | High        |
| **Hybrid (recommended)** | MCP + read-only sandbox | Native + MCP fallback | Native ExitPlanMode + MCP fallback       | Medium | Highest     |

**Recommendation**: Hybrid approach. Keep Claude's native ExitPlanMode. Add MCP `save_plan`
as the universal channel. Try Gemini's native plan mode if ACP hybrid works. Codex uses
MCP exclusively (no native plan mode in exec mode).

---

## 8. Test Plan

For each agent, verify:

1. [ ] Plan conversation starts (session created with correct permissionMode)
2. [ ] Agent runs in read-only mode (cannot write files)
3. [ ] Agent can explore the codebase (read files, search)
4. [ ] Agent can call MCP `save_plan` tool
5. [ ] Plan content appears in the plans table
6. [ ] Plan content appears in the plan editor (via polling)
7. [ ] "Break into tasks" works from the saved plan

Additional Gemini tests:

- [ ] `--experimental-acp` + `--approval-mode plan` hybrid works
- [ ] `exit_plan_mode` tool fires and can be detected
- [ ] Plan file written to `~/.gemini/tmp/` can be captured

Additional Codex tests:

- [ ] `--sandbox read-only` enforces read-only
- [ ] MCP tools work within read-only sandbox
- [ ] Resumed sessions: document that read-only is lost

---

## Addendum: CLI Integration Mode Findings (2026-03-04, round 2)

This section documents a fundamental re-evaluation of HOW Agendo integrates with each CLI,
going beyond plan mode to question the entire adapter architecture.

### Codex: `codex exec` → `codex app-server` (MAJOR CHANGE)

**Current approach**: Spawn `codex exec <prompt> --json` per turn. Kill process. Spawn
`codex exec resume <threadId> <message>` for follow-up. Repeat.

**Better approach**: Spawn `codex app-server` ONCE as a persistent process. Communicate
via JSON-RPC over stdio. This is what VS Code, macOS app, JetBrains, and Xcode all use.

#### `codex app-server` Protocol Overview

Transport: JSON-RPC 2.0 over stdio (or experimental WebSocket)

```
Client                          Server (app-server)
  ──── initialize ──────────────►
  ◄─── initialized ─────────────
  ──── thread/start ────────────►
  ◄─── thread/started ──────────
  ──── turn/start ──────────────►     (send prompt)
  ◄─── item/agentMessage/delta ──    (streaming text)
  ◄─── item/started ────────────     (tool use begin)
  ◄─── item/commandExecution/requestApproval ─► (approval request)
  ──── [approval response] ─────►     (approve/decline/cancel)
  ◄─── item/completed ──────────     (tool result)
  ◄─── item/plan/delta ─────────     (plan content streaming!)
  ◄─── turn/completed ──────────     (turn done, usage stats)
  ──── turn/start ──────────────►     (next message, SAME process)
  ──── thread/resume ───────────►     (resume previous session)
  ──── thread/fork ─────────────►     (branch from existing thread)
  ──── thread/rollback ─────────►     (undo N turns)
  ──── thread/compact/start ────►     (compress context)
```

Key methods:

- `thread/start` / `thread/resume` / `thread/fork` / `thread/read` / `thread/list` / `thread/rollback`
- `turn/start` / `turn/steer` / `turn/interrupt`
- `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`
- `item/tool/requestUserInput`
- `config/read` / `config/batchWrite` / `config/mcpServer/reload`
- `model/list` / `review/start` / `command/exec`

Schema generation: `codex app-server generate-ts` and `generate-json-schema` produce
typed bindings matching the exact binary version.

#### Benefits over `codex exec`

| Feature           | `codex exec` (current) | `codex app-server` (recommended)        |
| ----------------- | ---------------------- | --------------------------------------- |
| Process model     | New per turn           | **Single persistent**                   |
| Multi-turn        | Kill + resume          | **`turn/start` (same process)**         |
| Approvals         | None (bypass only)     | **Full bidirectional**                  |
| Streaming         | NDJSON items only      | **Delta notifications**                 |
| MCP persistence   | Re-init every turn     | **Once per thread**                     |
| Plan streaming    | Not handled            | **`item/plan/delta`**                   |
| Thread management | Manual                 | **resume/fork/rollback/compact**        |
| Config changes    | Requires restart       | **`config/batchWrite`**                 |
| Pattern match     | Virtual process hack   | **Matches Claude's persistent process** |

#### Implementation Impact

A new `CodexAppServerAdapter` would:

1. Replace `codex-adapter.ts` entirely
2. Follow the same persistent-process pattern as `claude-adapter.ts`
3. Map app-server notifications to `AgendoEventPayload` (new event mapper needed)
4. Handle `item/commandExecution/requestApproval` → existing `ApprovalHandler`
5. Support `item/plan/delta` for plan content streaming
6. Eliminate the "virtual process" hack and kill-per-turn overhead

#### Also Available: `@openai/codex-sdk` (v0.107.0)

```typescript
import { Codex } from '@openai/codex-sdk';
const codex = new Codex({ config: { model: 'gpt-5.3-codex' } });
const thread = codex.startThread({ workingDirectory: '/path' });
const result = await thread.run('Fix the tests'); // first turn
const result2 = await thread.run('Run linter'); // multi-turn, SAME thread
const { events } = await thread.runStreamed('Diagnose'); // streaming
```

Simpler but doesn't expose approval handling or MCP config. Could be a stepping stone.

#### Also Available: `codex mcp-server`

Codex can run AS an MCP server, exposing `codex` and `codex-reply` tools. Designed for
the Agents SDK pattern where an orchestrator calls Codex as a tool. Not useful for direct
session management.

#### Codex Feature Flags

| Feature               | Stage        | Default | Notes                 |
| --------------------- | ------------ | ------- | --------------------- |
| `multi_agent`         | experimental | false   | Built-in multi-agent  |
| `collaboration_modes` | stable       | true    | Plan/default modes    |
| `steer`               | stable       | true    | Steer in-flight turns |
| `memory_tool`         | under dev    | false   | Persistent memory     |

### Gemini: ACP is Correct (CONFIRMED)

**Conclusion**: ACP (`--experimental-acp`) is the right protocol. Every IDE uses it.
No better alternative exists for multi-turn sessions.

#### What COULD be improved

1. **`@agentclientprotocol/sdk`** (v0.14.1): Could replace the manual JSON-RPC handling
   in `gemini-adapter.ts`. Provides `ClientSideConnection`, type-safe interfaces, message
   framing. Would remove ~200 lines of request/response correlation code.

2. **Headless `stream-json` for executions**: For fire-and-forget template-mode capabilities,
   `gemini -p "prompt" -o stream-json --approval-mode yolo` is simpler than ACP.
   NDJSON events: `init`, `message`, `tool_use`, `tool_result`, `result`.
   MCP works: `--allowed-mcp-server-names agendo` (tested on this machine).

3. **TOML policy files** instead of `--approval-mode yolo`:

   ```toml
   [[rule]]
   mcpName = "agendo"
   toolName = "*"
   decision = "allow"
   priority = 200
   ```

4. **Emerging ACP features** (v0.33-preview):
   - `set_model` interface (eliminates process-restart hack in `setModel()`)
   - ACP slash commands (`/memory`, `/init`, `/extensions`, `/restore`)
   - A2A remote agents (Gemini as remote agent, not subprocess)
   - MCP OAuth for remote MCP servers

### Revised Priority Order

1. **Codex: Migrate to `app-server`** — Biggest impact. Fixes plan mode, approvals,
   streaming, MCP persistence, and multi-turn overhead all at once. Aligns with how every
   serious integration works.

2. **MCP `save_plan` tool** — Universal plan capture for all agents. Quick win.

3. **Agent-specific plan prompts** — Per-agent prompt in `startPlanConversation()`. Quick win.

4. **Gemini: Enable `--approval-mode plan`** — Test hybrid with `--experimental-acp`.

5. **Gemini: Consider ACP SDK** — Nice-to-have code quality improvement.

6. **Gemini: Headless `stream-json` for executions** — Optional simplification.
