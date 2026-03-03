# Conversation Rewind / Branching — Research & Design

_Researched 2026-03-02 by Claude Code agent_

---

## TL;DR

Claude Code CLI (v2.1.63) has built-in support for resuming a conversation from any past
assistant message via `--resume-session-at <assistantMsgUUID>`. Combined with the existing
`--fork-session` flag, this is the exact primitive needed for Agendo's "Branch from here" feature.

Codex and Gemini **do not support** per-message branching in their CLI flags.

---

## 1. Claude Code CLI Mechanism

### 1.1 Relevant flags

| Flag                                     | Description                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `--resume <sessionId>`                   | Resume an existing session (already used in Agendo)                              |
| `--resume-session-at <assistantMsgUUID>` | Only include messages up to this assistant message. Works in `--print` mode.     |
| `--fork-session`                         | Create a new session ID instead of reusing the original (already used in Agendo) |
| `--rewind-files <userMsgUUID>`           | **Standalone** operation: restore files to state at that user message and exit   |

### 1.2 Full branch invocation

```bash
claude --print \
  --input-format stream-json \
  --output-format stream-json \
  --resume <parentSessionRef> \
  --resume-session-at <assistantMsgUUID> \
  --fork-session \
  "New prompt for the branch"
```

This creates a **new Claude session** whose conversation history contains only the messages up to
(and including) `assistantMsgUUID`. The new session ID is returned via a `system:init` event (same
as current fork mechanism).

### 1.3 Where do message UUIDs come from?

Claude's stream-json output includes a `uuid` field on **every** event (user, assistant,
stream_event). These UUIDs are identical to the UUIDs stored in Claude's JSONL session files under
`~/.claude/projects/<project>/`.

Verification: The `assistant` event emitted by Claude during a session turn has:

```json
{
  "type": "assistant",
  "uuid": "4cea5da7-b713-46d2-a593-6f020486c232",  // ← this UUID
  "session_id": "f823377b-...",
  "message": { "id": "msg_01...", ... }
}
```

This same `uuid` appears verbatim in the `.jsonl` session file. So we can capture it from
Agendo's existing log files or from the live event stream.

### 1.4 File restoration

Two mechanisms exist for restoring filesystem state to match an earlier conversation point:

1. **Pre-session flag** (`--rewind-files <userMsgUUID>`): Only restores files (standalone, exits
   immediately). Must be used alongside `--resume`.

2. **In-session control request** (`rewind_files` subtype): Can be sent as a control request via
   stdin during a live session. Rewinds file changes made since a specific user message.

   Format: `{"type": "control_request", "request_id": "...", "request": {"subtype": "rewind_files", "user_message_uuid": "..."}}`

**Important**: The TUI `/rewind` command operates **in-memory** and is only available in
interactive mode. For Agendo (non-interactive `--print` mode), the restart-based approach using
`--resume-session-at` is required.

---

## 2. Codex & Gemini

| CLI    | Mechanism                  | Per-message branch?                 |
| ------ | -------------------------- | ----------------------------------- |
| Codex  | `codex fork [SESSION_ID]`  | No — forks from latest state only   |
| Gemini | `--resume latest\|<index>` | No — resumes from latest state only |

Branching at a specific message is **Claude-only** in Agendo's current agent set.

---

## 3. Current Agendo State

### What already exists

- `sessions.sessionRef` — stores Claude session ID (used for `--resume`)
- `sessions.parentSessionId` — links fork to parent
- `sessions.forkSourceRef` — stores parent's `sessionRef` for `--fork-session`
- `POST /api/sessions/:id/fork` — creates a forked session
- `ClaudeAdapter.resume(sessionRef, prompt, opts)` — already passes `--fork-session` if
  `opts.forkSession` is set

### What's missing

1. **Assistant message UUID tracking**: The `claude-event-mapper.ts` discards the `uuid` field
   from `assistant` events. This UUID is needed for `--resume-session-at`.
2. **`resumeSessionAt` field on session**: Nowhere to store which message to stop at when starting
   a forked session.
3. **`--resume-session-at` adapter support**: `ClaudeAdapter.resume()` doesn't pass this flag yet.
4. **UI**: No "Branch from here" button on turns.

---

## 4. Data Model Changes

### 4.1 Sessions table (migration)

Add one column:

```sql
ALTER TABLE sessions ADD COLUMN resume_session_at text;
-- NULL = no truncation (full history); present = assistant UUID to stop at
```

In `src/lib/db/schema.ts`:

```typescript
// The Claude assistant message UUID to stop at when resuming via --resume-session-at.
// Used for conversation branching: fork resumes parent history only up to this point.
resumeSessionAt: text('resume_session_at'),
```

### 4.2 Message UUID tracking (assistant events)

Add `messageUuid?: string` to `AgendoEventPayload` for the `agent:result` event:

```typescript
// In events.ts, the agent:result payload:
| (EventBase & {
    type: 'agent:result';
    // ... existing fields ...
    /** Claude message UUID of the assistant turn just completed (for branching). */
    messageUuid?: string;
  })
```

In `claude-event-mapper.ts`, when an `assistant` event arrives, capture `parsed.uuid` and
attach it to the next `agent:result` event.

**Alternative (simpler)**: Parse the log file on demand at branch time. The log already contains
`[stdout] {"type":"assistant","uuid":"..."}` for every turn. No schema/event changes needed for
the event system.

---

## 5. Implementation Plan

### Phase 1: Adapter + session service (backend only)

**Files to change**:

- `src/lib/db/schema.ts` — add `resumeSessionAt` column
- `src/lib/worker/adapters/types.ts` — add `resumeSessionAt?: string` to `SpawnOpts`
- `src/lib/worker/adapters/claude-adapter.ts` — pass `--resume-session-at` flag when set
- `src/lib/services/session-service.ts` — extend `forkSession()` to accept `resumeAt?` param
- `src/app/api/sessions/[id]/fork/route.ts` — accept `resumeAt` in request body
- `src/lib/worker/session-process.ts` — pass `resumeSessionAt` from session to spawn opts

**New DB migration**: `0013_sessions_resume_at.ts`

### Phase 2: Message UUID extraction

Two options (pick one):

**Option A: Log parsing on demand** (simpler, no event changes)

- Create `src/lib/services/session-log-reader.ts`
- Function `getAssistantMessageUuids(logFilePath)` → returns array of `{uuid, preview, index}`
- Parses `[stdout] {...}` lines, finds `type==="assistant"` events, extracts uuid + text preview
- Called by branch API at fork time to validate the UUID

**Option B: Store UUID in DB per turn** (more robust, requires schema change)

- Add event extraction in `claude-event-mapper.ts`
- Store `lastAssistantUuid` in session state
- Persist to DB (new `session_turns` table or column on sessions)

**Recommendation**: Option A is much simpler. The UUID can be passed directly from the frontend
(which can read it from the event stream via SSE), and validated against the log file.

### Phase 3: API changes

**`POST /api/sessions/:id/fork`** body change:

```typescript
{
  resumeAt?: string; // assistantMsgUUID — if provided, creates a branch from that point
}
```

**`GET /api/sessions/:id/turns`** (NEW, optional for Phase 3)

- Returns list of completed turns with their assistant message UUIDs
- Parsed from the session log file
- Used by the UI to build the branch picker

### Phase 4: Frontend UI

**Session chat view changes**:

- Each completed assistant turn shows a "Branch" button (on hover)
- Clicking opens a small popover: "Continue conversation from here?"
- Confirming calls `POST /api/sessions/:id/fork` with the `resumeAt` UUID
- On success, navigates to the new forked session

**Branch indicator**:

- Sessions with `parentSessionId` show a "← Branched from [parent title]" badge
- The original session shows a "Branches: N" count in its header

---

## 6. Sequence of Events

```
User hovers assistant turn #3 in session A
  → "Branch from here" button appears

User clicks → confirms
  → POST /api/sessions/A/fork { resumeAt: "uuid-of-assistant-msg-3" }
  → forkSession(A, "uuid-of-assistant-msg-3")
    → creates session B with:
       forkSourceRef = A.sessionRef
       resumeSessionAt = "uuid-of-assistant-msg-3"
       parentSessionId = A.id
  → session B is enqueued

Worker picks up session B
  → SessionProcess.start()
    → detects isForkStart && session.resumeSessionAt
    → calls adapter.resume(forkSourceRef, prompt, {
         forkSession: true,
         resumeSessionAt: "uuid-of-assistant-msg-3"
       })

ClaudeAdapter.resume() builds:
  claude --print --input-format stream-json --output-format stream-json
    --resume <A.sessionRef>
    --resume-session-at uuid-of-assistant-msg-3
    --fork-session
    "User's new message"

Claude creates new session starting from history[0..turn3]
  → system:init fires with new session_id
  → saved as B.sessionRef
  → B is now an independent session with the truncated history
```

---

## 7. Open Questions

1. **File state restoration**: Should branching also restore the filesystem to the state at the
   branch point? This would require running `--rewind-files` (or the `rewind_files` control
   request) before starting the new session. Filesystem state at a specific point is tracked by
   Claude's file-history snapshots in the JSONL file.
   - **Recommendation**: Do NOT do this in the initial implementation. File rewind is complex and
     risky (could overwrite user's work). The branch just creates a conversation-only branch.

2. **User message UUIDs**: The user wants to "branch from message B" (a user message). But
   `--resume-session-at` takes an **assistant** message UUID. The natural mapping is:
   "branch from after assistant response N" = `--resume-session-at <assistantMsgN.uuid>`.
   The UI should show branch points at assistant messages (the end of a completed turn), not at
   user messages (which haven't been processed yet).

3. **Which message to show the button on**: In the UX description, the user hovers on a user
   message. In the CLI, we use the UUID of the assistant response to that message. So the button
   on user message B should use the UUID of the assistant response _after_ B.

4. **Codex/Gemini sessions**: Cannot branch at a specific message. The existing fork mechanism
   (fork from latest) still works for them.

5. **Log file availability**: Sessions that were run before this feature existed won't have UUID
   metadata in Agendo's events. But the Claude JSONL files still exist and can be parsed
   retroactively if needed.

---

## 8. Complexity Assessment

| Phase                                         | Effort | Risk                                |
| --------------------------------------------- | ------ | ----------------------------------- |
| Phase 1: Backend (schema + adapter + service) | Medium | Low — extends existing patterns     |
| Phase 2: Log parsing utility                  | Small  | Low                                 |
| Phase 3: API changes                          | Small  | Low                                 |
| Phase 4: Frontend UI                          | Medium | Low — extends session view          |
| File rewind (optional)                        | Large  | Medium — risky filesystem operation |

**Total estimate for core feature (no file rewind)**: ~3-4 days of implementation work.

The hardest part is ensuring the frontend correctly identifies the assistant message UUID for
each turn, since this UUID comes from Claude's stream-json output and needs to be surfaced to the
user. The log-parsing approach (Option A) avoids storing this in the DB but requires the log file
to be accessible when the user wants to branch.
