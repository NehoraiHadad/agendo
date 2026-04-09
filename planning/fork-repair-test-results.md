# Fork Mechanism — Test Results (2026-04-09)

## Environment

- Worker build: post-repair (commits f6c2c51..5e5b311)
- Gemini CLI: v0.34.0
- Codex: latest via `codex app-server`

## Test Results

### ✅ Claude — Bare Fork (toolbar "Fork" button)

- **Flow**: `POST /api/sessions/:id/fork` with empty body
- **forkSourceRef**: set to `parent.sessionRef` ✅
- **Mechanism**: `adapter.resume(forkSourceRef, prompt, { forkSession: true })`
- **Result**: Agent responded with full summary of parent session history ✅

### ✅ Claude — Edit Fork (BranchPopover with `resumeAt`)

- **Flow**: `POST /api/sessions/:id/fork` with `{ resumeAt, initialPrompt }`
- **forkSourceRef**: set to `parent.sessionRef` ✅
- **forkPointUuid**: set to `resumeAt` ✅
- **Mechanism**: `adapter.resume(forkSourceRef, prompt, { forkSession: true, resumeSessionAt })`
- **Note**: Passing a non-existent UUID as `resumeAt` correctly returns
  `"No message found with message.uuid of: ..."` — validates the fork-at-point path.

### ✅ Codex — Bare Fork

- **Flow**: `POST /api/sessions/:id/fork` with empty body
- **forkSourceRef**: set to parent's `threadId` ✅
- **Mechanism**: `adapter.fork()` → `thread/fork` JSON-RPC
- **Log**: `"thread/fork succeeded"` — new `threadId` assigned ✅
- **Result**: Agent continued working in parent's research context ✅

### ✅ Gemini — Bare Fork (with fallback)

- **Attempted**: `transport.forkSession()` → `unstable_forkSession` (ACP)
- **Result**: `"Method not found": session/fork` — Gemini CLI v0.34.0 does not
  implement the `session/fork` RPC handler (the ACP SDK client has the code but
  the CLI server has not yet enabled it)
- **Fallback**: `session/load` with parent `sessionId` → succeeded ✅
- **Effect**: Fork resumes the parent session (not a true independent fork, but
  agent sees full history) ✅

### — Copilot

No existing sessions with `sessionRef` available for testing.
Expected to behave identically to Gemini (shares `AbstractAcpAdapter`).

---

## Gemini Upgrade Assessment

Checked v0.34.0 (installed) and v0.37.0 (latest stable) — neither implements
`session/fork` on the server side. The `unstable_forkSession` method is in the
ACP SDK client since ~v0.14 but Gemini CLI has not wired up the server handler.

**Recommendation**: Do not upgrade for this feature. The fallback (`session/load`)
works correctly and the upgrade path is zero-effort — when Gemini adds server-side
support, the code will start using it automatically without any changes.

---

## Summary

| Agent   | Native Fork         | Fallback                     | History Received         |
| ------- | ------------------- | ---------------------------- | ------------------------ |
| Claude  | ✅ `--fork-session` | —                            | ✅ Full                  |
| Codex   | ✅ `thread/fork`    | —                            | ✅ Full                  |
| Gemini  | ❌ not implemented  | ✅ `session/load`            | ✅ Full (shared session) |
| Copilot | ❌ not tested       | ✅ `session/load` (expected) | —                        |
