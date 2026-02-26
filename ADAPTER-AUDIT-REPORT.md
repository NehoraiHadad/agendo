# Adapter Implementation Audit Report

**Date:** 2026-02-26
**Audited by:** Claude Opus 4.6 (4 parallel research agents)
**Verified against:** Actual CLI `--help` output on this machine

---

## Executive Summary

| Adapter                       | Status             | Critical | High  | Medium | Low | Info |
| ----------------------------- | ------------------ | -------- | ----- | ------ | --- | ---- |
| Claude                        | ✅ Mostly Correct  | 0        | 0     | 1      | 2   | 2    |
| Codex                         | ▲ **Issues Found** | 0        | **4** | 1      | 1   | 1    |
| Gemini                        | ▲ Issues Found     | 0        | 0     | 2      | 2   | 1    |
| Integration (session-process) | ▲ Issues Found     | 0        | 0     | 0      | 4   | 2    |

**Codex adapter has 4 HIGH issues** — wrong item type names (`file_search` → `file_change`, `mcp_call` → `mcp_tool_call`), wrong text field (`item.content` → `item.text`), and invalid flags on resume. Text output currently works only due to a buffer-flush fallback; tool events are completely invisible. Claude and Gemini are production-stable with minor improvements needed.

---

## 1. Claude Adapter (`claude-adapter.ts`)

### Status: ✅ Correct

### CLI Flags Verified Against `claude --help`

All flags we pass are valid and current:

- `--input-format stream-json` ✅
- `--output-format stream-json` ✅
- `--verbose` ✅
- `--include-partial-messages` ✅
- `--permission-mode <mode>` ✅ (choices: acceptEdits, bypassPermissions, default, dontAsk, plan)
- `--max-budget-usd` ✅
- `--fallback-model` ✅
- `--strict-mcp-config` ✅
- `--append-system-prompt` ✅
- `--resume <sessionRef>` ✅
- Persistent session (omit `-p`) ✅
- `--mcp-config` (via extraArgs from session-runner) ✅

### NDJSON Protocol: ✅ Correct

- User message format: `{type:"user", message:{role:"user", content}, session_id, parent_tool_use_id: null}` ✅
- Tool result format: `{type:"user", message:{role:"user", content:[{type:"tool_result",...}]}, session_id, parent_tool_use_id: null}` ✅
- Image content: `{type:"image", source:{type:"base64", media_type, data}}` ✅
- Session ID extraction from `{type:"system", subtype:"init", session_id}` ✅
- Result detection: `{type:"result"}` → thinking=false ✅

### Control Request/Response: ✅ Correct

- Outbound: `{type:"control_request", request_id, request:{subtype:"interrupt"|"set_permission_mode"|"set_model"|"mcp_status"}}` ✅
- Inbound: `{type:"control_request", request_id, request:{subtype:"can_use_tool"}}` ✅
- Response: `{type:"control_response", request_id, response:{subtype:"allow"|"deny", updatedInput?}}` ✅

### Resume: ✅ Correct

- `--resume <sessionRef>` matches `claude --help` output (`-r, --resume [value]`)

### Issues

| #       | Severity   | File:Line                 | Description                                                                                                                                                                                                                                                                                     |
| ------- | ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C-1** | **Medium** | claude-adapter.ts:342-368 | Missing `--permission-prompt-tool stdio` flag. Agent SDKs (Python/TS/Elixir) all set this to enable `control_request` can_use_tool events. Without it, CLI may prompt interactively (hang) or auto-approve in non-bypass modes. Currently mitigated by most sessions using `bypassPermissions`. |
| C-2     | Low        | claude-adapter.ts:58-79   | Slash commands list could add `/config`, `/fast` if they exist. Unknown commands safely fall through to NDJSON messages.                                                                                                                                                                        |
| C-3     | Low        | claude-adapter.ts:316     | `allow-session` PermissionDecision maps to `subtype: 'allow'` — no protocol-level session-scoped approval. Correct behavior (one-time per request).                                                                                                                                             |
| C-4     | Info       | claude-adapter.ts:345-368 | `--include-partial-messages` help says "only works with --print" but functions correctly in persistent session mode with stream-json I/O. Relies on undocumented compatibility.                                                                                                                 |
| C-5     | Info       | —                         | New flags available: `--model`, `--effort`, `--allowedTools`, `--disallowedTools`, `--replay-user-messages`, `--no-session-persistence`, `--max-turns`                                                                                                                                          |

---

## 2. Codex Adapter (`codex-adapter.ts` + `codex-event-mapper.ts`)

### Status: ▲ **Issues Found (4 HIGH)**

### CLI Flags — `codex exec` ✅ vs `codex exec resume` ▲

**`exec` flags (all correct):**

- `codex exec [PROMPT] --json` ✅
- `-C, --cd <DIR>` ✅
- `--dangerously-bypass-approvals-and-sandbox` ✅
- `--sandbox read-only | workspace-write | danger-full-access` ✅

**`exec resume` flags (ISSUES):**

- `codex exec resume [SESSION_ID] [PROMPT] --json` ✅
- `-C, --cd <DIR>` ❌ **NOT VALID** on resume (confirmed via `codex exec resume --help`)
- `--sandbox <mode>` ❌ **NOT VALID** on resume
- `--dangerously-bypass-approvals-and-sandbox` ✅ (valid on resume)
- `--full-auto` ✅ (valid on resume)

### Item Type Names: ❌ **WRONG**

Official Codex docs state item types are: "agent messages, reasoning, command executions, **file changes**, **MCP tool calls**, web searches, and plan updates."

| Our Name            | Correct Name        | Status       |
| ------------------- | ------------------- | ------------ |
| `command_execution` | `command_execution` | ✅           |
| `file_search`       | `file_change`       | ❌ **WRONG** |
| `mcp_call`          | `mcp_tool_call`     | ❌ **WRONG** |
| `reasoning`         | `reasoning`         | ✅           |
| `agent_message`     | `agent_message`     | ✅           |
| —                   | `web_search`        | MISSING      |
| —                   | `todo_list`         | MISSING      |

### Item Text Field: ❌ **WRONG**

Official docs sample:

```json
{
  "type": "item.completed",
  "item": {
    "id": "item_3",
    "type": "agent_message",
    "text": "Repo contains docs, sdk, and examples directories."
  }
}
```

Our mapper reads `item.content[].output_text` but the actual field is **`item.text`** (top-level). Text currently works ONLY because of the `dataBuffer` flush fallback in `session-process.ts:1121`.

### Issues

| #       | Severity | File:Line                      | Description                                                                                                                       |
| ------- | -------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **X-1** | **HIGH** | codex-event-mapper.ts:167-171  | `agent_message` reads `item.content[].output_text` — should read `item.text`. Produces empty text; fallback buffer masks the bug. |
| **X-2** | **HIGH** | codex-event-mapper.ts:27-30,74 | `file_search` type name is wrong — should be `file_change`. File operations completely invisible.                                 |
| **X-3** | **HIGH** | codex-event-mapper.ts:32-36,74 | `mcp_call` type name is wrong — should be `mcp_tool_call`. MCP tool calls completely invisible.                                   |
| **X-4** | **HIGH** | codex-event-mapper.ts:159-163  | `reasoning` likely uses `item.text` too (same pattern as `agent_message`). Thinking text may be silently dropped.                 |
| X-5     | Medium   | codex-adapter.ts:171-173       | `--cd` and `--sandbox` passed to `exec resume` but not accepted. May cause CLI parse errors.                                      |
| X-6     | Low      | codex-adapter.ts (missing)     | No `--model` flag support.                                                                                                        |
| X-7     | Info     | —                              | Missing `item.updated` event type (real-time streaming of in-progress items).                                                     |

---

## 3. Gemini Adapter (`gemini-adapter.ts` + `gemini-event-mapper.ts`)

### Status: ▲ Issues Found (Medium)

### CLI Flags Verified Against `gemini --help`

- `gemini --experimental-acp` ✅ (still experimental, not renamed)

### ACP Handshake: ✅ Correct

- `initialize` with `{protocolVersion: 1, clientInfo, clientCapabilities}` ✅
- `session/new` with `{cwd, mcpServers}` ✅
- MCP env format `[{name, value}]` array ✅

### Session/Prompt: ✅ Correct

- `session/prompt` with `{sessionId, prompt: [{type:"text", text}]}` ✅
- Image support with `{type:"image", data, mimeType}` ✅
- No-retry design (prevents duplicate messages) ✅

### Permission Handling: ✅ Correct

- NESTED outcome: `{outcome: {outcome: "selected", optionId}}` ✅
- Option kind matching: `allow_once` / `reject_once` ✅

### FS Operations: ✅ Correct

- `fs/read_text_file` with `{path, line?, limit?}` → `{content}` ✅
- `fs/write_text_file` with `{path, content}` → `null` ✅

### Issues

| #   | Severity   | File:Line                 | Description                                                                                                                                                                                                                                                                                 | Suggested Fix                                      |
| --- | ---------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| G-1 | **Medium** | gemini-adapter.ts:181-194 | **Double exit callback on init failure.** `initAndRun().catch()` fires `exitCallbacks(0)`, then process kill triggers `cp.on('exit')` which fires `exitCallbacks` again. Session-process's `exitHandled` guard protects against this in practice, but the adapter itself should prevent it. | Add `exitFired` boolean guard in `launch()`.       |
| G-2 | **Medium** | gemini-adapter.ts:327-345 | **Incomplete session/update handling.** Only handles `agent_message_chunk` and `agent_thought_chunk`. Missing `tool_call_start`, `tool_call_end`, `tool_result` types means auto-approved tool activity is invisible in the UI.                                                             | Add handlers for tool-related sessionUpdate types. |
| G-3 | Low        | gemini-adapter.ts:360     | `protocolVersion: 1` may become outdated. Currently correct.                                                                                                                                                                                                                                | Monitor ACP spec.                                  |
| G-4 | Low        | gemini-adapter.ts:140     | No model selection flag passed. Gemini supports `-m, --model`. Could be useful.                                                                                                                                                                                                             | Forward model from session settings.               |
| G-5 | Info       | —                         | FS operations may need expansion (`fs/list_directory`, `fs/stat`, etc.) if future Gemini CLI versions require them.                                                                                                                                                                         |

---

## 4. Integration Layer (`session-process.ts`)

### Status: ▲ Issues Found (Minor)

### Adapter Wiring: ✅ Correct

- spawn/resume delegation ✅
- SpawnOpts population ✅
- Approval handler wired before spawn ✅
- onThinkingChange wired ✅
- onSessionRef wired for non-Claude adapters ✅

### Data Parsing Pipeline: ✅ Correct

- Dual buffering (adapter + session-process) is by design ✅
- Claude adapter forwards raw text, session-process applies its own line buffering ✅
- `adapter.mapJsonToEvents()` delegation for Codex/Gemini ✅

### State Machine: ✅ Correct

- `idle → active → awaiting_input → active → ... → ended` ✅
- slotReleaseFuture resolved correctly ✅
- exitFuture resolved correctly (including claim-failure early return) ✅
- Kill flags (terminateKilled, cancelKilled, interruptKilled, idleTimeoutKilled) all working ✅
- `exitHandled` guard prevents double onExit ✅

### Text Delta Streaming: ✅ Correct

- 200ms batching ✅
- Published to PG NOTIFY, NOT persisted to log ✅
- Flushed on exit ✅
- `fromDelta` flag prevents doubling with complete text ✅

### Issues

| #   | Severity | File:Line                   | Description                                                                                                                                                                   | Suggested Fix                                                                    |
| --- | -------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| S-1 | Low      | session-process.ts:~402     | `adapter.mapJsonToEvents()` call not wrapped in try/catch. A malformed event from Codex/Gemini could break the data callback for remaining lines in that chunk.               | Wrap in try/catch with console.warn.                                             |
| S-2 | Low      | session-process.ts:~760     | Delta events increment `eventSeq` but don't persist to DB. Creates sequence gaps. Harmless in practice (deltas are ephemeral) but technically a seq collision risk on resume. | Use separate counter for delta IDs, or periodically batch-update DB.             |
| S-3 | Low      | session-process.ts:~1277    | `endedAt` set on all process exits, even when transitioning to `idle`. An idle session with `endedAt` is semantically misleading.                                             | Only set `endedAt` for `ended` transitions.                                      |
| S-4 | Low      | session-process.ts:~637     | `void db.update(...)` for cost stats — DB failures silently lost.                                                                                                             | Add `.catch(console.error)`.                                                     |
| S-5 | Info     | session-process.ts:~350     | Stderr content logged with `[stdout]` prefix (adapter merges stdout+stderr into one callback). Cosmetic.                                                                      | No fix needed — refactoring ManagedProcess for separate streams is too invasive. |
| S-6 | Info     | session-process.ts:~384-480 | Double JSON.parse (adapter + session-process) for every NDJSON line. Negligible performance impact, correct by design.                                                        | No fix needed.                                                                   |

---

## Cross-Cutting Findings

### Environment Variable Handling: ✅ Correct

- `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` stripped ✅
- Gemini MCP env uses `[{name, value}]` array format ✅
- Codex reads env from ecosystem.config.js ✅

### PG NOTIFY Payload Limits: ✅ Correct

- 7500-byte limit handled by pg-notify.ts ref stub replacement ✅
- Large tool outputs written in full to log file ✅

### Process Group Cleanup: ✅ Correct

- All adapters use `detached: true` and `process.kill(-pid, signal)` for group cleanup ✅
- Gemini init failure correctly kills process group ✅

---

## Recommended Fix Priority

### Tier 1 — HIGH (Codex JSONL protocol bugs):

1. **X-1: Codex `agent_message` text field** — Read `item.text` instead of `item.content[].output_text`
2. **X-2: Codex `file_search` → `file_change`** — Wrong item type name, file ops invisible
3. **X-3: Codex `mcp_call` → `mcp_tool_call`** — Wrong item type name, MCP invisible
4. **X-4: Codex `reasoning` text field** — Same `item.text` issue as agent_message

### Tier 2 — MEDIUM:

5. **X-5: Codex resume flags** — `--cd` and `--sandbox` invalid on `exec resume`
6. **C-1: Claude `--permission-prompt-tool stdio`** — Required by Agent SDK convention
7. **G-1: Gemini double exit callback** — Add `exitFired` guard in launch()
8. **G-2: Gemini session/update tool events** — Handle tool_call_start/end

### Tier 3 — LOW (defensive improvements):

9. **S-1: mapJsonToEvents try/catch** — Defensive error handling
10. **S-3: endedAt only on ended transitions** — Semantic correctness
11. **S-4: Cost stats DB error logging** — Observability
12. **X-6: Codex `--model` flag** — Forward model preference

## Agendo Tasks Created

All fixes have been filed as tasks in the agendo project (ID: 26d1d2e3).
