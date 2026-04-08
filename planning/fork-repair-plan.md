# Fork Mechanism Repair — Implementation Plan

## Problem Statement

The fork mechanism ("Edit & Branch") fails to transfer conversation context to the new session in most cases:

1. **Claude forks without `resumeAt`** (editing the first message) — agent starts fresh, zero context
2. **Non-Claude forks (Codex, Gemini, Copilot)** — always start fresh because `messageUuid` is never set on `agent:result`, so `resumeAt` is never sent
3. **UI illusion** — the frontend shows parent history (via `parentStream`), but the agent is blind to it

### Root Cause

In `session-service.ts` → `forkSession()`:

```typescript
forkSourceRef: resumeAt ? (parent.sessionRef ?? null) : null,
```

`forkSourceRef` is only set when `resumeAt` is provided. Without it, `isForkStart` in `session-process.ts` is `false`, and the session starts as a fresh `spawn()`.

### Native Fork Mechanisms Available (but not wired up)

| Agent   | Protocol | Method                                                      | Status                               |
| ------- | -------- | ----------------------------------------------------------- | ------------------------------------ |
| Claude  | SDK      | `resume` + `forkSession: true` + optional `resumeSessionAt` | ✅ Works when `forkSourceRef` is set |
| Codex   | JSON-RPC | `thread/fork { threadId }` → new thread with copied history | ❌ Not implemented                   |
| Gemini  | ACP      | `unstable_forkSession({ sessionId })` → new session         | ❌ Method exists but not called      |
| Copilot | ACP      | Same as Gemini (shares `AcpTransport`)                      | ❌ Method exists but not called      |

---

## Implementation Phases

### Phase 1: Fix Claude Fork — Always Set `forkSourceRef`

**File**: `src/lib/services/session-service.ts`

**Change**: In `forkSession()`, always set `forkSourceRef` to parent's session ref:

```typescript
// BEFORE (broken)
forkSourceRef: resumeAt ? (parent.sessionRef ?? null) : null,

// AFTER (fixed)
forkSourceRef: parent.sessionRef ?? null,
```

**Effect**:

- With `resumeAt`: Claude forks from specific point (truncated history) — same as before
- Without `resumeAt`: Claude forks from end of conversation (full history) — NEW, fixes bug
- `forkPointUuid` remains `resumeAt ?? null` — unchanged (UI truncation still gated on `resumeAt`)

**session-process.ts behavior** (unchanged):

```
isForkStart = !!forkSourceRef && !session.sessionRef  → true for all forks with parent ref
adapter.resume(forkSourceRef, prompt, { forkSession: true, resumeSessionAt })
```

When `resumeSessionAt` is undefined: `--resume X --fork-session` → fork from end (full history).
When `resumeSessionAt` is set: `--resume X --fork-session --resume-session-at Y` → fork from point Y.

**Risk**: Low. Only affects the BranchPopover UI flow (`POST /api/sessions/:id/fork`). Team creation and other flows use `createSession()` directly, not `forkSession()`.

---

### Phase 2: Add `SupportsFork` Interface

**File**: `src/lib/worker/adapters/types.ts`

Add a new optional capability interface:

```typescript
/**
 * Adapters that support native conversation forking.
 * Fork creates a new session with the parent's conversation history.
 */
export interface SupportsFork {
  /**
   * Fork from an existing session, creating a new session with the parent's history.
   *
   * @param sourceRef - The parent session/thread ID to fork from
   * @param prompt - The first user message for the forked session
   * @param opts - Spawn options (cwd, env, model, permissions, etc.)
   */
  fork(sourceRef: string, prompt: string, opts: SpawnOpts): ManagedProcess;
}

/** Type guard for adapters that support native fork. */
export function supportsFork(adapter: AgentAdapter): adapter is AgentAdapter & SupportsFork {
  return 'fork' in adapter && typeof (adapter as Record<string, unknown>).fork === 'function';
}
```

**Note**: Claude does NOT need `SupportsFork` — its fork works via the existing `resume()` method with `forkSession: true` in SpawnOpts. `SupportsFork` is for adapters with a distinct fork protocol.

---

### Phase 3: Implement `fork()` in CodexAppServerAdapter

**File**: `src/lib/worker/adapters/codex-app-server-adapter.ts`

Add `fork()` method that uses `thread/fork` JSON-RPC:

```typescript
implements SupportsFork {
  fork(sourceRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    // Same as spawn() but passes sourceRef to runInitChain as a fork target
    return this.launchProcess(prompt, opts, undefined, sourceRef);
  }
}
```

In `runInitChain()`, add a third path alongside start/resume:

```typescript
if (forkThreadId) {
  // Fork an existing thread → new thread with copied history
  const result = await this.transport.call('thread/fork', {
    threadId: forkThreadId,
    cwd: opts.cwd,
    approvalPolicy: getApprovalPolicy(opts.permissionMode),
    sandbox: getSandboxMode(opts.permissionMode),
    model: opts.model ?? null,
    persistExtendedHistory: true,
    ...(this.developerInstructions ? { developerInstructions: this.developerInstructions } : {}),
  });
  const thread = (result.thread as Record<string, unknown>) ?? result;
  this.threadId = thread.id as string;
  this.threadModel = (result.model as string) ?? '';
  this.sessionRefCallback?.(this.threadId);
  this.emitSynthetic({
    type: 'as:thread.started',
    threadId: this.threadId,
    model: this.threadModel,
  });
} else if (resumeThreadId) {
  // ... existing resume path
} else {
  // ... existing start path
}
```

**Protocol details** (from `planning/research-codex-cli.md`):

- Request: `thread/fork { threadId, cwd, model, approvalPolicy, sandbox, ... }`
- Response: `ThreadForkResponse` — same as `ThreadStartResponse` with a new `thread.id`
- History from parent thread is copied to the new thread
- `turn/start` follows to send the initial prompt

---

### Phase 4: Implement `fork()` in AbstractAcpAdapter (Gemini/Copilot)

**File**: `src/lib/worker/adapters/base-acp-adapter.ts`

Add `fork()` method using the existing `transport.forkSession()`:

```typescript
implements SupportsFork {
  fork(sourceRef: string, prompt: string, opts: SpawnOpts): ManagedProcess {
    // Launch like spawn but with a fork source
    return this.launchWithFork(prompt, this.prepareOpts(opts), sourceRef);
  }
}
```

In `initAndRun()`, add fork path:

```typescript
protected async initAndRun(
  prompt: string,
  opts: SpawnOpts,
  resumeSessionId: string | null,
  forkSessionId: string | null = null,  // NEW parameter
): Promise<void> {
  try {
    const initResult = await this.transport.initialize();

    if (forkSessionId) {
      // Fork path: create new session from existing one
      this.sessionId = await this.transport.forkSession(forkSessionId);
      this.sessionRefCallback?.(this.sessionId);
    } else {
      // Existing resume/new path
      this.sessionId = await this.transport.loadOrCreateSession(
        initResult.agentCapabilities,
        { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] },
        resumeSessionId,
      );
      if (!resumeSessionId && this.sessionId) {
        this.sessionRefCallback?.(this.sessionId);
      }
    }
  } catch (err) { ... }
```

**Graceful degradation**: `unstable_forkSession` may not be supported by all agent versions. Wrap in try/catch, and on failure fall through to `loadOrCreateSession()` (resume) or `newSession()` (fresh start). Log a warning.

---

### Phase 5: Update session-process.ts Fork Routing

**File**: `src/lib/worker/session-process.ts`

Replace the current fork block with adapter-aware routing:

```typescript
import { supportsFork } from '@/lib/worker/adapters/types';

// Determine how to start: fork, resume, or spawn.
const forkSourceRef = this.session.forkSourceRef;
const isForkStart = !!forkSourceRef && !this.session.sessionRef;

if (isForkStart) {
  if (supportsFork(this.adapter)) {
    // Native fork — adapter uses its own fork protocol (thread/fork, forkSession, etc.)
    this.managedProcess = this.adapter.fork(forkSourceRef, prompt, spawnOpts);
  } else {
    // Claude path — fork via resume with forkSession flag
    this.managedProcess = this.adapter.resume(forkSourceRef, prompt, {
      ...spawnOpts,
      forkSession: true,
      resumeSessionAt,
    });
  }
} else if (resumeRef) {
  // ... existing resume path (unchanged)
} else {
  // ... existing spawn path (unchanged)
}
```

**Why Claude doesn't use SupportsFork**: Claude's fork is syntactically a `resume()` with extra flags. It fits naturally into the existing `resume()` call with `opts.forkSession = true`. Adding a separate `fork()` method would be redundant and duplicate the resume logic.

---

### Phase 6: Context-Extraction Fallback

**File**: `src/lib/worker/session-process.ts`

When native fork fails (e.g., agent doesn't persist sessions, or unstable API errors), fall back to extracting context from the parent's log and prepending it to the prompt:

```typescript
if (isForkStart) {
  try {
    if (supportsFork(this.adapter)) {
      this.managedProcess = this.adapter.fork(forkSourceRef, prompt, spawnOpts);
    } else {
      this.managedProcess = this.adapter.resume(forkSourceRef, prompt, {
        ...spawnOpts,
        forkSession: true,
        resumeSessionAt,
      });
    }
  } catch (forkErr) {
    log.warn(
      { err: forkErr, sessionId: this.session.id },
      'Native fork failed, falling back to context extraction',
    );

    // Fallback: extract context from parent session and prepend to prompt
    const parentId = this.session.parentSessionId;
    if (parentId) {
      const { extractSessionContext } = await import('@/lib/services/context-extractor');
      const extracted = await extractSessionContext(parentId, { mode: 'hybrid' });
      if (extracted.prompt) {
        prompt = extracted.prompt + '\n\n---\n\n' + prompt;
      }
    }
    this.managedProcess = this.adapter.spawn(prompt, spawnOpts);
  }
}
```

**Note**: This is a safety net. The primary path should always succeed for Claude (resume + fork-session) and should work for Codex (thread/fork if threads are persisted to disk). For Gemini/Copilot with `unstable_forkSession`, the fallback is more likely to be needed.

---

## Testing Strategy

### Unit Tests

1. **session-service.test.ts** — verify `forkSession()` always sets `forkSourceRef`:
   - Fork with `resumeAt` → `forkSourceRef = parent.sessionRef`, `forkPointUuid = resumeAt`
   - Fork without `resumeAt` → `forkSourceRef = parent.sessionRef`, `forkPointUuid = null`
   - Fork when parent has no `sessionRef` → `forkSourceRef = null` (still creates fork)

2. **codex-app-server-adapter.test.ts** — verify `thread/fork` call:
   - `fork()` calls `thread/fork` with correct params
   - New threadId is emitted via sessionRefCallback
   - `turn/start` follows with the prompt

3. **base-acp-adapter.test.ts** — verify ACP fork:
   - `fork()` calls `transport.forkSession()` with correct sessionId
   - New sessionId is emitted via sessionRefCallback
   - Prompt is sent to the new session

4. **session-process fork routing** — verify `supportsFork` dispatch:
   - Claude adapter → uses `resume()` with `forkSession: true` (no `SupportsFork`)
   - Codex adapter → uses `fork()` via `SupportsFork`
   - Gemini adapter → uses `fork()` via `SupportsFork`
   - Unknown adapter → falls back to `resume()` with fork flags

### Integration Verification

After deployment (`pm2 restart agendo-worker`):

1. Open a Claude session, send a few messages, edit the first message → verify fork carries full history
2. Open a Claude session, edit a non-first message → verify fork carries history up to that point
3. (If Codex/Gemini sessions are available) test fork from those sessions

---

## Files Changed Summary

| File                                                      | Change                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/lib/services/session-service.ts`                     | `forkSourceRef: parent.sessionRef ?? null` (remove `resumeAt ?` guard)         |
| `src/lib/worker/adapters/types.ts`                        | Add `SupportsFork` interface + `supportsFork()` type guard                     |
| `src/lib/worker/adapters/codex-app-server-adapter.ts`     | Add `fork()` method + `thread/fork` in init chain                              |
| `src/lib/worker/adapters/base-acp-adapter.ts`             | Add `fork()` method + fork path in `initAndRun()`                              |
| `src/lib/worker/session-process.ts`                       | Update fork routing: `supportsFork` → native, else Claude flags, with fallback |
| `src/lib/services/__tests__/session-fork-service.test.ts` | Update existing tests                                                          |
| New test files                                            | Tests for Codex fork, ACP fork, session-process routing                        |

---

## Execution Order

1. **Phase 1** first — fixes the most common case (Claude same-agent fork) with a one-line change
2. **Phase 2** next — adds the interface (no functional change yet)
3. **Phases 3-4** together — implement native fork in Codex and ACP adapters
4. **Phase 5** — wire the routing in session-process
5. **Phase 6** last — add the fallback safety net
6. Tests throughout (TDD: write failing test → implement → verify green)

## Risk Assessment

- **Phase 1**: Very low risk — one-line change, only affects BranchPopover flow
- **Phase 2**: Zero risk — only adds types, no runtime change
- **Phase 3**: Medium risk — `thread/fork` is documented but never tested in Agendo. Codex may have edge cases. Mitigation: fallback in Phase 6
- **Phase 4**: Medium risk — `unstable_forkSession` is explicitly marked unstable. Mitigation: try/catch + fallback
- **Phase 5**: Low risk — routing logic is straightforward, well-tested
- **Phase 6**: Low risk — context extraction is already battle-tested in the cross-agent switch flow
