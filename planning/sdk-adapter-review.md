# SDK Adapter Code Review

**Date:** 2026-03-11
**Reviewer:** Claude Sonnet 4.6
**Files reviewed:** `sdk-event-mapper.ts`, `build-sdk-options.ts`, `claude-sdk-adapter.ts`

---

## Summary

The three SDK adapter files are well-implemented and correct. The migration from raw NDJSON stdout parsing to the typed SDK eliminates ~400 lines of line-buffering and JSON-parsing boilerplate. No critical issues found. A few minor clarifications and improvements are noted below.

---

## Critical Issues

None.

---

## Important Issues

### 1. `sendToolResult` pushes a message — but SDK handles tool results via `canUseTool`

**File:** `claude-sdk-adapter.ts` lines 163–179

The `sendToolResult` method pushes a `tool_result` content block as a user turn into the async queue. However, in SDK mode, tool results are handled internally by the SDK through the `canUseTool` callback — the SDK never yields control back to the user for tool results like the old stdin NDJSON protocol did.

**Assessment:** This method likely goes unused in practice. It should either be removed or documented as a no-op that exists for interface compatibility only. If somehow called, it may confuse the SDK's internal state machine.

**Recommendation:** Add a log warning if called, or assert it's never called in SDK mode:

```typescript
async sendToolResult(toolUseId: string, content: string): Promise<void> {
  // In SDK mode, tool results are handled internally by canUseTool().
  // This path should never be reached; log a warning if it is.
  log.warn({ toolUseId }, 'sendToolResult called in SDK mode — this is a no-op');
}
```

---

## Minor Issues

### 2. `session_id: ''` in user messages

**File:** `claude-sdk-adapter.ts` lines 155–160, 173–178

Both `sendMessage()` and `sendToolResult()` push messages with `session_id: ''`. The SDK type requires `session_id: string` on `SDKUserMessage`. Passing an empty string is technically valid (the SDK overwrites it internally) but could cause confusion when reading logs or debugging.

**Recommendation:** Use the session ID from the `system:init` event once it's known:

```typescript
// After session:init fires, capture and reuse the real session_id
private currentSessionId = '';
// In onSessionRef callback: this.currentSessionId = ref;
// In sendMessage: session_id: this.currentSessionId,
```

### 3. `sdkCallbacks` cache not invalidated on `spawn`/`resume`

**File:** `claude-sdk-adapter.ts` lines 336

`this.sdkCallbacks = null` is set in `_start()`, which is correct. However, `setActivityCallbacks()` also nulls it out. The order dependency (activity callbacks must be set before the first message processes) is not documented. Consider adding a comment.

### 4. `build-sdk-options.ts` — `resolveCliPath()` uses `require.resolve`

**File:** `build-sdk-options.ts` lines 9–13

`require.resolve('@anthropic-ai/claude-agent-sdk')` resolves the SDK entry point and constructs `cli.js` via `join(sdkEntry, '..', 'cli.js')`. This is fragile — if the SDK restructures its package layout, `cli.js` may no longer be a sibling of the entry point.

**Assessment:** Low-risk as Anthropic has kept this stable across 130+ releases, but worth watching. The SDK's `pathToClaudeCodeExecutable` option exists precisely for this use case so the approach is correct.

### 5. `rate_limit_event` and `auth_status` mapped — verify event types exist

**File:** `sdk-event-mapper.ts` lines 252–275

These two event types (`system:rate-limit`, handling `auth_status` → `system:info`/`system:error`) should be verified against `AgendoEventPayload` union to ensure the shapes are accepted downstream. If `system:rate-limit` is not in the union, it will silently be ignored or cause a type error at runtime.

---

## Missing Features

### A. `reconnectMcpServer` / `toggleMcpServer` not wired to control route

The adapter exposes `reconnectMcpServer()` and `toggleMcpServer()` methods but `src/app/api/sessions/[id]/control/route.ts` may not have handlers for them yet. These are useful for the MCP health-check flow.

### B. `rewindFiles()` not wired to any UI action

The adapter implements `rewindFiles(userMessageId, dryRun?)` but there's no UI entry point or API route to call it yet. Useful future feature for undoing destructive file edits.

---

## Positive Observations

- **AsyncQueue** implementation is clean and correctly handles the FIFO/waiter pattern. The `isDone` guard prevents dropped messages.
- **`allowDangerouslySkipPermissions`** is correctly set when `permissionMode === 'bypassPermissions'`.
- **`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` filtering** is done in `build-sdk-options.ts` exactly as required.
- **`persistSession: false`** is correctly set when `noSessionPersistence` is true.
- **`pid: 0`** is documented with a comment about ActivityTracker's `if (pid)` guard.
- **Resume logic** correctly clears `sessionId` when `resume` is set, preventing the "No conversation found" conflict.
- **SdkEventMapperCallbacks** decoupling is clean — no circular deps between mapper and adapter.
- **`onThinkingChange`** state machine: called with `true` on `assistant` block arrival and `false` on `result` arrival, matching existing session lifecycle expectations.
- **`compact_boundary`** metadata (`trigger`, `pre_tokens`) is correctly extracted and mapped.
- **`modelUsage`** per-model breakdown mapped 1:1 from SDK types.
- **`permission_denials`** correctly strips `toolInput` from the emitted event (privacy-safe).

---

## Verdict

✅ **Ready for production.** The migration is solid. Address item #1 (`sendToolResult` no-op) and item #2 (`session_id`) in a follow-up if clean code is a priority, but neither is a blocker.
