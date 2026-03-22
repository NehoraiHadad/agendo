# Provider Capability Matrix

> Generated 2026-03-22 by systematic codebase analysis of all adapter implementations.
> Source files: `src/lib/worker/adapters/*.ts`, `session-runner.ts`, `session-preambles.ts`, `approval-handler.ts`

## Summary Matrix

| Capability                        |             Claude              |                 Codex                  |                  Gemini                   |                  Copilot                  |               OpenCode                |
| --------------------------------- | :-----------------------------: | :------------------------------------: | :---------------------------------------: | :---------------------------------------: | :-----------------------------------: |
| **MCP Tools**                     |          ✓ SDK native           |          ✓ config/batchWrite           |             ✓ ACP mcpServers              |         ✓ --additional-mcp-config         |       ✓ OPENCODE_CONFIG_CONTENT       |
| **Model Switching**               |        ✓ SDK setModel()         |         ✓ setDefaultModel RPC          | ✓ ACP in-place (v0.33+), fallback restart |        ⚠️ unstable_setSessionModel        |           ✗ Not implemented           |
| **Permission: bypassPermissions** |                ✓                |     ✓ (never + danger-full-access)     |         ✓ (--approval-mode yolo)          |                ✓ (--yolo)                 |         ✓ (config injection)          |
| **Permission: acceptEdits**       |                ✓                | ✓ (auto-accept files, prompt commands) |       ✓ (--approval-mode auto_edit)       | ⚠️ (--allow-all-tools --allow-all-paths)  |         ✓ (config injection)          |
| **Permission: plan**              |      ✓ Native ExitPlanMode      |         ✓ (read-only sandbox)          |         ✓ (--approval-mode plan)          |        ✓ (--deny-tool enforcement)        |         ⚠️ (ACP mode-change)          |
| **Permission: default**           |                ✓                |             ✓ (on-request)             |                     ✓                     |                     ✓                     |                   ✓                   |
| **Plan Mode**                     |      ✓ ExitPlanMode native      |  ✓ read-only sandbox + save_plan MCP   |  ✓ --approval-mode plan + save_plan MCP   | ✓ --deny-tool=write/shell + save_plan MCP | ⚠️ No native plan; save_plan MCP only |
| **Session Persistence**           |         ✓ JSONL on disk         |            ✓ thread/resume             |            ✓ ACP session/load             |              ✓ --resume flag              |           ✗ Not implemented           |
| **Multi-turn**                    |          ✓ AsyncQueue           |          ✓ turn/start per msg          |         ✓ ACP session/sendPrompt          |         ✓ ACP session/sendPrompt          |       ✓ ACP session/sendPrompt        |
| **Text Delta Streaming**          |         ✓ stream_event          |        ✓ item/outputText/delta         |             ✓ ACP text-delta              |             ✓ ACP text-delta              |           ✓ ACP text-delta            |
| **Thinking/Reasoning**            |        ✓ thinking_delta         |         ✓ item/reasoning/delta         |             ✓ thinking-delta              |             ✓ thinking-delta              |           ✓ thinking-delta            |
| **Tool Events**                   |     ✓ tool_use/tool_result      |        ✓ item/tool/start + end         |           ✓ ACP tool-start/end            |           ✓ ACP tool-start/end            |         ✓ ACP tool-start/end          |
| **Bash/Terminal**                 |                ✓                |             ✓ (sandboxed)              |                     ✓                     |                     ✓                     |                   ✓                   |
| **Approval Flow**                 |       ✓ canUseTool SDK cb       |         ✓ requestApproval RPC          |         ✓ ACP request_permission          |         ✓ ACP request_permission          |       ✓ ACP request_permission        |
| **Custom Commands/Skills**        |       ✓ .claude/commands/       |     ✓ skills/list + .codex/skills/     |         ✓ .gemini/commands/ TOML          |                     ✗                     |                   ✗                   |
| **File Checkpointing**            |    ✓ enableFileCheckpointing    |                   ✗                    |                     ✗                     |                     ✗                     |                   ✗                   |
| **Conversation Branching**        | ✓ forkSession + resumeSessionAt |    ✓ thread/fork + thread/rollback     |                     ✗                     |                     ✗                     |                   ✗                   |
| **Context Compaction**            |         ✓ Auto-compact          |         ✓ thread/compact/start         |                     ✗                     |                     ✗                     |                   ✗                   |
| **Interrupt**                     |       ✓ query.interrupt()       |          ✓ turn/interrupt RPC          |           ⚠️ SIGINT escalation            |           ⚠️ SIGINT escalation            |         ⚠️ SIGINT escalation          |
| **Steer (mid-turn)**              |                ✗                |              ✓ turn/steer              |                     ✗                     |                     ✗                     |                   ✗                   |
| **History Retrieval**             |     ✓ JSONL + SDK fallback      |           ✓ thread/read RPC            |      ✓ In-memory + log file fallback      |      ✓ In-memory + log file fallback      |    ✓ In-memory + log file fallback    |
| **Image Attachments**             |         ✓ Native base64         |                   ✗                    |            ⚠️ ACP image parts             |            ⚠️ ACP image parts             |          ⚠️ ACP image parts           |
| **Usage/Cost Tracking**           |      ✓ Detailed per-model       |          ✓ tokenUsage/updated          |      ⚠️ Basic (from ACP turn result)      |      ⚠️ Basic (from ACP turn result)      |    ⚠️ Basic (from ACP turn result)    |
| **SDK Hooks**                     |        ✓ Pre/PostToolUse        |                   ✗                    |                     ✗                     |                     ✗                     |                   ✗                   |
| **SDK Subagents**                 |       ✓ sdkAgents config        |                   ✗                    |                     ✗                     |                     ✗                     |                   ✗                   |
| **Output Format (JSON Schema)**   |         ✓ outputFormat          |                   ✗                    |                     ✗                     |                     ✗                     |                   ✗                   |
| **Worktree Isolation**            |          ✓ --worktree           |                   ✗                    |                     ✗                     |                     ✗                     |                   ✗                   |

---

## Detailed Per-Provider Analysis

### 1. Claude Code (claude-sdk-adapter.ts)

**Protocol**: `@anthropic-ai/claude-agent-sdk` — in-process TypeScript SDK, no child process spawn. Uses `query()` with `AsyncQueue<SDKUserMessage>` for multi-turn.

**MCP Tools**:

- Injected via SDK `Options.mcpServers` (stdio transport definitions).
- `generateSdkSessionMcpServers()` in `mcp/config-templates.ts` builds the config.
- Supports runtime `setMcpServers()`, `reconnectMcpServer()`, `toggleMcpServer()`.
- MCP health check via `mcpServerStatus()`.
- Gate: `agent.mcpEnabled && binaryName === 'claude'` in session-runner.ts.

**Model Switching**:

- `setModel(model)` via `queryInstance.setModel()` — in-place, no restart.
- `--model` passed via `buildSdkOptions()` at session start.
- Default model resolved via `getDefaultModel('claude')`.

**Permission Modes**:

- All 5 modes supported: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`.
- `setPermissionMode()` changes mode in-place via SDK control request.
- `allowDangerouslySkipPermissions: true` required for `bypassPermissions`.
- `canUseTool` callback delegates to `approvalHandler` for `default` mode.

**Plan Mode**:

- Native `ExitPlanMode` tool — gold standard implementation.
- Plans saved to `~/.claude/plans/` automatically.
- `approval-handler.ts` captures plan content on ExitPlanMode approval.
- Plan-page sessions: ExitPlanMode auto-denied (agent stays in plan mode).
- Preamble: "use ExitPlanMode to finalize" instruction.

**Session Persistence**:

- JSONL files in `~/.claude/projects/` (unless `noSessionPersistence: true`).
- Resume via `resume` option in SDK `query()` call.
- Fork via `forkSession: true` + optional `resumeSessionAt` for branching.
- `getHistory()` reads JSONL directly (fast path ~1ms) or SDK fallback (~89ms).

**Streaming**:

- `includePartialMessages: true` enables `stream_event` text deltas.
- `agentProgressSummaries: true` for progress events.
- `promptSuggestions: true` for follow-up suggestions.
- Delta batching: 200ms flush interval via `appendDelta()`.

**Unique Features**:

- File checkpointing (`enableFileCheckpointing`) + `rewindFiles()`.
- SDK hooks (`sdkHooks`) — Pre/PostToolUse callbacks.
- SDK subagents (`sdkAgents`) — programmatic agent definitions.
- Structured output (`outputFormat`) — JSON schema validation.
- Git worktree isolation (`--worktree`).
- Custom commands from `~/.claude/commands/` and `{cwd}/.claude/commands/`.
- Settings loaded from `user`, `project`, `local` sources.
- `interrupt()` via `queryInstance.interrupt()`.
- `cancelQueuedMessage()` — remove messages from AsyncQueue before SDK consumes them.

**Evidence**: `claude-sdk-adapter.ts` (617 lines), `build-sdk-options.ts` (103 lines), `sdk-event-mapper.ts`.

---

### 2. Codex CLI (codex-app-server-adapter.ts)

**Protocol**: `codex app-server` — persistent JSON-RPC 2.0 over NDJSON (stdin/stdout). Same protocol used by VS Code, JetBrains, Xcode integrations.

**MCP Tools**:

- Injected via `config/batchWrite` RPC after `initialized` notification.
- Uses `generateGeminiAcpMcpServers()` format (shared with Gemini).
- Env converted from `AcpMcpServer[]` array format to plain dict.
- MCP health check via `mcpServerStatus/list` RPC (60s interval).
- Gate: `agent.mcpEnabled && binaryName === 'codex'` in session-runner.ts.

**Model Switching**:

- `setModel(model)` via `setDefaultModel` JSON-RPC call — in-place, no restart.
- `model` passed in `thread/start` and `thread/resume` params.
- Known context window bug: CLI reports stale 258,400 for all models. Manual override map in adapter for gpt-5.2-codex (400K), gpt-5.3-codex (400K), gpt-5.4 (1.05M), o3 (200K), o4-mini (200K).

**Permission Modes**:

- Maps to `approvalPolicy` + `sandboxPolicy`:
  - `bypassPermissions` / `dontAsk` → `never` + `danger-full-access`
  - `plan` → `on-request` + `read-only`
  - `default` / `acceptEdits` → `on-request` + `workspace-write`
- `setPermissionMode()` stores locally, applied on next turn (no in-flight change).
- Note: `acceptEdits` maps to same as `default` — Codex doesn't distinguish file edits from commands at the policy level.

**Plan Mode**:

- `read-only` sandbox prevents writes/executes.
- Preamble instructs agent to use `mcp__agendo__save_plan` MCP tool.
- No native ExitPlanMode equivalent.
- `developerInstructions` field injects plan preamble.

**Session Persistence**:

- Threads stored on disk by Codex CLI.
- `thread/resume` resumes existing thread with full history.
- `thread/fork` creates branch from existing thread.
- `thread/rollback` removes last N turns.
- `thread/list` lists all threads (optionally by cwd).
- `getHistory()` via `thread/read` RPC (requires running app-server).

**Streaming**:

- `item/outputText/delta` → `agent:text-delta`
- `item/reasoning/delta` → `agent:thinking-delta`
- `item/tool/start` + `item/tool/end` → tool events
- `item/plan/delta` → `agent:text-delta` (plan text)
- `thread/tokenUsage/updated` → `agent:usage`
- `turn/diff` → `system:info` with diff content

**Unique Features**:

- `steer(message)` — inject mid-turn steering via `turn/steer` RPC.
- `rollback(numTurns)` — undo last N turns via `thread/rollback`.
- Auto-compaction detection: watches for `contextCompaction` items + interrupted turns.
- `thread/compact/start` for manual compaction with watchdog timer.
- Skills discovery via `skills/list` RPC + filesystem scan (`~/.agents/skills/`, `{cwd}/.codex/skills/`).
- `tmux` session wrapper for process isolation.

**Approval Flow**:

- Server → Client: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `codex/requestUserInput`
- Client → Server: `{ decision: "accept"|"acceptForSession"|"decline"|"cancel" }`
- Separate handlers for command execution, file changes, and user input requests.
- Note: decisions use `"accept"` not `"approved"`.

**Evidence**: `codex-app-server-adapter.ts` (950+ lines), `codex-approval-handlers.ts`, `codex-app-server-event-mapper.ts`.

---

### 3. Gemini CLI (gemini-adapter.ts)

**Protocol**: ACP (Agent Client Protocol) via `@agentclientprotocol/sdk` over stdio. Spawns `gemini --experimental-acp`.

**MCP Tools**:

- Injected via ACP `session/new` `mcpServers` field.
- Env format: `Array<{name, value}>` (NOT `Record<string,string>` — Gemini's Zod schema).
- `--allowed-mcp-server-names` CLI flag whitelists MCP servers.
- Gate: `agent.mcpEnabled && binaryName === 'gemini'` in session-runner.ts.

**Model Switching**:

- `setModel(model)` first attempts in-place ACP `unstable_setSessionModel` call (available since Gemini CLI v0.33.0, PR #20991).
- Falls back to **process restart** if ACP call fails (older Gemini CLI versions): kills old process group (SIGTERM), waits for exit, spawns new `gemini` process with updated `-m model`, re-initializes ACP, reloads session.
- `modelSwitching` flag suppresses exit callbacks during restart (fallback path only).
- Model passed via `-m` flag at spawn time; `storedOpts.model` updated on successful in-place switch.

**Permission Modes**:

- Maps to `--approval-mode` CLI flag:
  - `bypassPermissions` / `dontAsk` → `yolo`
  - `acceptEdits` → `auto_edit`
  - `plan` → `plan`
  - `default` → (no flag, default behavior)
- In-place change via ACP `setSessionMode()` using `acpModeMap`:
  - `default` → `default`, `acceptEdits` → `autoEdit`, `bypassPermissions` → `yolo`
- Note: `plan` mode NOT in `acpModeMap` — requires process restart or CLI flag at spawn.

**Plan Mode**:

- `--approval-mode plan` works with `experimental.plan: true` in `~/.gemini/settings.json`.
- Gemini has native `enter_plan_mode`/`exit_plan_mode` tools.
- Plans written to `~/.gemini/tmp/<project>/<session-id>/plans/`.
- Agendo preamble instructs to use `mcp__agendo__save_plan` (ACP shared preamble).
- Permission mode set to `bypassPermissions` for plan sessions (allows MCP calls).

**Session Persistence**:

- ACP session created/loaded via `transport.loadOrCreateSession()`.
- Resume via `session/load` with existing sessionId.
- In-memory message history accumulated via `accumulateHistory()` in base-acp-adapter.
- `getHistory()` returns in-memory history when available; falls back to Agendo log file after worker restart.

**Streaming**:

- Shared ACP event mapper: `text-delta`, `thinking-delta`, `tool-start`, `tool-end`, `turn-complete`, `turn-error`, `plan`, `mode-change`, `usage`, `session-info`, `commands`.
- Text deltas merged into `agent:text` entries in message history.

**Unique Features**:

- Custom TOML commands from `~/.gemini/commands/` and `{cwd}/.gemini/commands/`.
- Subdirectory namespacing: `git/commit.toml` → `/git:commit`.
- TOML commands merged with ACP-reported commands (ACP takes priority on collision).
- Policy files via `--policy` flag (TOML-based tool-level control).
- `onAfterInit()` hook loads custom commands after ACP init.

**Approval Flow**:

- ACP `session/request_permission` with nested response: `{ outcome: { outcome: 'selected', optionId } }`.
- Gemini Zod validates `output.outcome.optionId` — flat response causes "Required" error.
- Handled by `GeminiClientHandler`.

**Evidence**: `gemini-adapter.ts` (237 lines), `base-acp-adapter.ts` (394 lines), `gemini-client-handler.ts`, `acp-event-mapper.ts`.

---

### 4. GitHub Copilot CLI (copilot-adapter.ts)

**Protocol**: ACP (Agent Client Protocol) — same as Gemini. Spawns `copilot --acp --no-auto-update --disable-builtin-mcps`.

**MCP Tools**:

- Injected via `--additional-mcp-config` CLI flag with JSON: `{ mcpServers: { name: { command, args, env } } }`.
- Env converted from ACP array format to plain dict.
- No ACP `mcpServers` field (Copilot uses CLI flag instead).
- Wired in session-runner.ts — `binaryName === 'copilot'` added to Phase A2 MCP injection gate (2026-03-22).

**Model Switching**:

- `setModel(model)` via `unstable_setSessionModel` ACP method.
- `--model` flag passed at spawn time.
- Note: `unstable_` prefix suggests experimental/unreliable API.

**Permission Modes**:

- Maps to CLI flags:
  - `bypassPermissions` / `dontAsk` → `--yolo`
  - `plan` → `--deny-tool=write --deny-tool=shell` (blocks writes + shell, MCP tools remain available)
  - `acceptEdits` → `--allow-all-tools --allow-all-paths`
  - `default` → (no flags)
- In-place change via ACP `setSessionMode()` using `acpModeMap` (same as Gemini).

**Plan Mode**:

- No native plan mode equivalent.
- `--deny-tool=write --deny-tool=shell` blocks file writes and shell execution at the CLI level.
- MCP tools (including `mcp__agendo__save_plan`, `get_my_task`, etc.) are NOT blocked — read-only analysis and plan capture work normally.
- Read operations (file reads, grep, glob) are permitted.
- Preamble uses shared ACP plan preamble: instructs `mcp__agendo__save_plan`.
- Permission mode set to `bypassPermissions` for plan sessions (allows MCP calls).

**Session Persistence**:

- `--resume=<sessionId>` flag for session resume.
- ACP session created/loaded via shared `AbstractAcpAdapter` base.
- In-memory history via `accumulateHistory()`; falls back to Agendo log file after worker restart.

**Streaming**:

- Shared ACP event mapper (identical to Gemini): text-delta, thinking-delta, tool-start/end, turn-complete, etc.

**Unique Features**:

- `--no-auto-update` and `--disable-builtin-mcps` flags for stable, isolated operation.
- No custom commands/skills support.

**Approval Flow**:

- ACP `request_permission` via `CopilotClientHandler`.
- Same nested response format as Gemini.

**Known Limitations**:

- Model switching via unstable API.

**Evidence**: `copilot-adapter.ts` (89 lines), inherits from `base-acp-adapter.ts`.

---

### 5. OpenCode (opencode-adapter.ts)

**Protocol**: ACP (Agent Client Protocol) — same as Gemini/Copilot. Spawns `opencode --acp`.

**MCP Tools**:

- Injected via `OPENCODE_CONFIG_CONTENT` env var (JSON config injection).
- Also passed via ACP `mcpServers` field in session/new.
- Env format: array of `{name, value}` pairs (ACP standard).
- Wired in session-runner.ts — `binaryName === 'opencode'` added to Phase A2 MCP injection gate (2026-03-22).

**Model Switching**:

- Not implemented — no `setModel()` override in adapter.
- Inherits base `AbstractAcpAdapter` which has no `setModel()`.

**Permission Modes**:

- Injected via `OPENCODE_CONFIG_CONTENT` env var — no CLI flags.
- Config maps tool names to `'allow'` or `'ask'` individually.
- `bypassPermissions`: all tools set to `allow`.
- `acceptEdits`: edit/write/read tools `allow`, bash `ask`.
- ACP `setSessionMode()` available via inherited base.

**Plan Mode**:

- Shared ACP plan preamble with `save_plan` MCP.
- No native plan mode enforcement.
- ACP `mode-change` events mapped to `session:mode-change`.

**Session Persistence**:

- No `--resume` flag handling in `buildArgs()`.
- ACP session created but resume not explicitly supported.
- In-memory history via `accumulateHistory()`; falls back to Agendo log file after worker restart.

**Streaming**:

- Shared ACP event mapper (identical to Gemini/Copilot).

**Known Limitations**:

- No model switching.
- No session resume.
- No custom commands/skills.

**Evidence**: `opencode-adapter.ts` (inherits `AbstractAcpAdapter`), `opencode-client-handler.ts`, `opencode-event-mapper.ts`.

---

## Recommendations

### Which Agent for What Task

| Task Type                      | Recommended Agent                            | Reason                                                                                 |
| ------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Autonomous coding**          | Claude                                       | Richest SDK integration, in-process efficiency, file checkpointing, worktree isolation |
| **Plan review**                | Claude (native) or Codex (read-only sandbox) | Claude: ExitPlanMode gold standard. Codex: enforced read-only sandbox                  |
| **Multi-model second opinion** | Codex or Gemini                              | Different model providers offer diverse perspectives                                   |
| **Cost-sensitive tasks**       | Codex (gpt-5.x models)                       | Different pricing tier                                                                 |
| **MCP-heavy workflows**        | Claude > Codex > Gemini                      | Claude: runtime MCP management. Codex: health check. Gemini: static injection          |
| **Session branching**          | Claude or Codex                              | Fork, rollback, resume-at-point support                                                |

### Critical Gaps to Address

1. ~~**Copilot MCP**: Not wired in `session-runner.ts`~~ — Fixed 2026-03-22.
2. ~~**OpenCode MCP**: Not wired in session-runner.ts~~ — Fixed 2026-03-22.
3. ~~**Copilot plan mode**: No read-only enforcement~~ — Fixed 2026-03-22 via `--deny-tool=write --deny-tool=shell`.
4. ~~**Gemini model switch**: Requires full process restart~~ — Fixed 2026-03-22: tries ACP `unstable_setSessionModel` first (v0.33+), falls back to restart on older CLIs.
5. ~~**ACP history**: Gemini/Copilot/OpenCode only have in-memory history — session log file is the only fallback for reconnection.~~ — Fixed: `getHistory()` in `base-acp-adapter.ts` now falls back to the Agendo log file when in-memory history is empty (e.g. after a worker restart).
6. ~~**Codex acceptEdits**: Maps identically to `default` mode~~ — Fixed 2026-03-22: auto-accepts `item/fileChange/requestApproval` in `handleServerRequest()`, commands still prompt.

### Feature Parity Priorities

1. ~~Add Gemini in-place model switch~~ — Fixed 2026-03-22: ACP try-first with restart fallback.
2. ~~Add Copilot plan mode enforcement~~ — Fixed 2026-03-22 via `--deny-tool` flags.
3. Add OpenCode session resume support
