# Refactor Map v3 — Round 2: True Modularization

## Private Method Extraction Analysis

### `claimSession()` (line 358)

**`this.*` dependencies**:

- Reads: `this.session.id`, `this.workerId`
- Writes: `this.eventSeq`, `this.slotReleaseFuture` (resolve), `this.exitFuture` (resolve)

**Could parameters replace `this`?** Yes. The function needs `sessionId` and `workerId` as inputs. The two Future resolves in the failure path are a side-effect, but they could be returned as a status code instead (caller handles the futures).

**Pure or near-pure?** Near-pure. It performs a single atomic DB update and returns a boolean + eventSeq. The only impurity is the DB call and logging.

**Reuse potential?** Moderate. The atomic claim pattern (UPDATE ... WHERE status IN (...) RETURNING) is a general pattern. Other orchestration code (e.g. execution-runner) could use a similar claim. However, the exact column set (`workerId`, `heartbeatAt`, `startedAt`) is specific to sessions.

**Verdict: Extract**

**Reason**: The logic is fully self-contained: one DB query, one decision, one return value. The two Future resolves on failure are caller-side cleanup, not core logic. The extracted function would be a clean `async function claimSession(sessionId, workerId): Promise<{ eventSeq: number } | null>` — null means already claimed, caller resolves futures.

**Proposed signature**:

```typescript
/**
 * Atomically claim a session row for execution.
 * Returns the claimed eventSeq on success, or null if already claimed.
 */
export async function claimSession(
  sessionId: string,
  workerId: string,
): Promise<{ eventSeq: number } | null>;
```

---

### `buildChildEnv()` (line 397)

**`this.*` dependencies**:

- Reads: `this.session.id`, `this.session.agentId`, `this.session.taskId`
- Writes: none

**Could parameters replace `this`?** Yes, trivially. The three session fields are simple strings. The `envOverrides` parameter is already explicit.

**Pure or near-pure?** Pure (aside from reading `process.env`, which is a global but treated as immutable input). No DB calls, no side effects, no state mutation.

**Reuse potential?** High. Building a sanitized child env is useful for any subprocess spawning — execution-runner, future test harness, CLI tooling. The CLAUDECODE stripping logic is universally needed when spawning agent subprocesses from inside a Claude Code session.

**Verdict: Extract**

**Reason**: This is the textbook extraction candidate. Zero writes to `this`, pure data transformation, high reuse potential. The session identity injection (AGENDO_SESSION_ID, etc.) is a trivial data pass-through.

**Proposed signature**:

```typescript
export interface SessionIdentity {
  sessionId: string;
  agentId: string;
  taskId: string | null;
}

/**
 * Build a sanitized child process environment for agent subprocesses.
 * Strips CLAUDECODE/CLAUDE_CODE_ENTRYPOINT, applies overrides, injects session identity.
 */
export function buildChildEnv(
  baseEnv: Record<string, string | undefined>,
  identity: SessionIdentity,
  envOverrides?: Record<string, string>,
): Record<string, string>;
```

---

### `buildSpawnOpts()` (line 429)

**`this.*` dependencies**:

- Reads: `this.spawnCwd`, `this.session.id`, `this.session.idleTimeoutSec`, `this.session.permissionMode`, `this.session.allowedTools`, `this.session.model`, `this.session.effort`, `this.session.kind`, `this.policyFilePath`

**Could parameters replace `this`?** Yes, but it becomes somewhat verbose — 9 reads from `this`, though most come from `this.session` (which is a single object). If we pass the whole `Session` object plus `spawnCwd` and `policyFilePath`, the parameter list stays reasonable.

**Pure or near-pure?** Pure. No DB calls, no side effects, no state mutation. It is a straightforward data-mapping function: Session fields -> SpawnOpts.

**Reuse potential?** Moderate. The mapping is specific to how Agendo sessions map to adapter SpawnOpts. However, if we ever add a "dry-run" or "preview spawn args" feature, this would be reusable.

**Verdict: Extract**

**Reason**: Pure data mapping with no side effects. The `this.*` reads are all from `this.session` (one object) plus two simple scalars. The function signature is clean: `(session, spawnCwd, policyFilePath, passthrough) => SpawnOpts`.

**Proposed signature**:

```typescript
/**
 * Assemble SpawnOpts from a session record and runtime context.
 */
export function buildSpawnOpts(
  session: Pick<
    Session,
    'id' | 'idleTimeoutSec' | 'permissionMode' | 'allowedTools' | 'model' | 'effort' | 'kind'
  >,
  spawnCwd: string,
  env: Record<string, string>,
  opts: {
    policyFilePath?: string;
    mcpConfigPath?: string;
    mcpServers?: AcpMcpServer[];
    initialImage?: ImageContent;
    developerInstructions?: string;
  },
): SpawnOpts;
```

---

### `cleanupResources()` (line 918)

**`this.*` dependencies**:

- Reads: `this.sigkillTimers`, `this.policyFilePath`, `this.unsubscribeControl`
- Writes: `this.sigkillTimers` (reset to []), `this.policyFilePath` (set to null), `this.unsubscribeControl` (call + set to null)
- Calls: `this.activityTracker.stopAllTimers()`, `this.approvalHandler.drain('deny')`, `this.teamManager.stop()`

**Could parameters replace `this`?** Partially. The three sub-manager calls (`activityTracker`, `approvalHandler`, `teamManager`) could be passed as parameters, but the function also mutates 3 fields directly (`sigkillTimers`, `policyFilePath`, `unsubscribeControl`). Returning "cleanup results" instead of mutating would be awkward — these are imperative tear-down operations, not data transforms.

**Pure or near-pure?** Impure. This is entirely side-effectful: clearing timers, calling `.drain()`, deleting files, nulling references. That is its purpose.

**Reuse potential?** None. The specific combination of resources (sigkill timers + approval drain + team stop + policy file + PG NOTIFY unsubscribe) is unique to SessionProcess.

**Verdict: Keep as private method**

**Reason**: This method exists purely to organize SessionProcess's exit cleanup into a readable block. It mutates 3 fields, calls 3 sub-managers with no clear return value, and has zero reuse outside this class. Extracting it would require passing 6+ parameters and 3 setter callbacks for no gain. It is already well-named and well-scoped as a private method.

---

### `determineExitStatus()` (line 948)

**`this.*` dependencies**:

- Reads: `this.session.id`, `this.session.taskId`, `this.session.agentId`, `this.status`, `this.cancelKilled`, `this.terminateKilled`, `this.activityTracker.idleTimeoutKilled`, `this.activityTracker.interruptKilled`, `this.activeToolInfo`
- Writes: `this.status` (via `this.transitionTo()`), DB writes via `this.emitEvent()`
- Calls: `this.emitEvent()`, `this.transitionTo()`, `recordInterruptionEvent()`, `spawnSync('tmux', ...)`, DB update for `endedAt`

**Could parameters replace `this`?** Borderline. The reads are spread across 4 different areas of state: session identity, exit flags (3 boolean flags), activity tracker flags (2 booleans), and in-flight tool info. These could be bundled into a `ExitContext` struct, but the method also calls `emitEvent()` and `transitionTo()` which are deeply tied to the class (they do DB writes + PG NOTIFY). You'd need to pass those as callbacks.

**Pure or near-pure?** Impure. It emits events, transitions session status, records DB interruption events, runs tmux commands, and writes `endedAt` to the DB.

**Reuse potential?** None. The exit-code-to-status mapping is specific to Agendo's session lifecycle flags. No other module would call this.

**Verdict: Keep as private method**

**Reason**: The function reads from 4 different state domains and performs 5 different kinds of side-effects (emit, transition, recordInterruption, tmux kill, DB endedAt). Making this standalone would require either: (a) a massive parameter struct with 10+ fields plus 2 callbacks, or (b) passing `this` under a different name (SessionProcess interface). Neither improves testability or clarity over the current private method. The logic is inherently coupled to SessionProcess's lifecycle state.

---

### `handleReEnqueue()` (line 1021)

**`this.*` dependencies**:

- Reads: `this.modeChangeRestart`, `this.sessionRef`, `this.session.id`, `this.session.sessionRef`, `this.clearContextRestart`, `this.clearContextRestartNewSessionId`, `this.cancelKilled`

**Could parameters replace `this`?** Yes. All reads are simple scalar values. They can be bundled into a small struct:

```typescript
{
  (sessionId,
    sessionRef,
    modeChangeRestart,
    clearContextRestart,
    clearContextRestartNewSessionId,
    cancelKilled,
    wasInterruptedMidTurn);
}
```

That's 7 fields — not trivial, but all are simple booleans/strings with no callbacks.

**Pure or near-pure?** Near-pure. The only side effect is calling `enqueueSession()`, which is a well-defined external API (pg-boss queue). No DB writes, no event emission, no state mutation. The `.catch()` blocks are fire-and-forget error handling.

**Reuse potential?** Low but non-zero. The re-enqueue decision logic could theoretically be used by a "session recovery" module or admin tool. The decision tree (mode change vs clear-context vs mid-turn interrupt) is business logic that could be unit-tested independently.

**Verdict: Borderline (lean Extract)**

**Reason**: The function is near-pure: it reads 7 scalar flags and makes 0-1 calls to `enqueueSession()`. It does NOT mutate any class state. The parameter count (7 booleans/strings + 1 boolean arg) is on the high side but manageable with a struct. The real value of extraction is **testability**: the re-enqueue decision tree has 4 branches with priority ordering (modeChange > clearContext > midTurnResume) that are currently only testable via full integration tests. As a standalone function, each branch could be unit-tested with simple inputs.

**Proposed signature** (if extracted):

```typescript
export interface ReEnqueueContext {
  sessionId: string;
  /** Current session ref (runtime, may differ from DB). */
  sessionRef: string | null;
  /** Persisted session ref from DB (fallback). */
  dbSessionRef: string | null;
  modeChangeRestart: boolean;
  clearContextRestart: boolean;
  clearContextRestartNewSessionId: string | null;
  cancelKilled: boolean;
}

/**
 * Determine whether and how to re-enqueue a session after exit.
 * Fire-and-forget: logs errors but does not throw.
 */
export function handleReEnqueue(ctx: ReEnqueueContext, wasInterruptedMidTurn: boolean): void;
```

---

## Summary Table

| Method                | Lines     | Verdict                       | Reason                                                                                     |
| --------------------- | --------- | ----------------------------- | ------------------------------------------------------------------------------------------ |
| `claimSession`        | 358-390   | **Extract**                   | Self-contained atomic DB op, clean return type, moderate reuse                             |
| `buildChildEnv`       | 397-424   | **Extract**                   | Pure function, zero state mutation, high reuse potential                                   |
| `buildSpawnOpts`      | 429-464   | **Extract**                   | Pure data mapping, reads only from Session object + 2 scalars                              |
| `cleanupResources`    | 918-942   | **Keep**                      | Imperative teardown, mutates 3 fields, calls 3 sub-managers, no reuse                      |
| `determineExitStatus` | 948-1015  | **Keep**                      | Reads 4 state domains, 5 kinds of side-effects, deeply coupled to class lifecycle          |
| `handleReEnqueue`     | 1021-1076 | **Borderline (lean Extract)** | Near-pure decision tree, testable in isolation, but 7 scalar inputs is borderline unwieldy |

## Recommended New Files

| File                                   | Exports                              | Rationale                                                                                                    |
| -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/lib/worker/session-claim.ts`      | `claimSession()`                     | Atomic claim is a cohesive operation used at session start; could be shared with future recovery/admin tools |
| `src/lib/worker/session-env.ts`        | `buildChildEnv()`, `SessionIdentity` | Pure env builder, universally needed when spawning agent subprocesses; high reuse                            |
| `src/lib/worker/spawn-opts-builder.ts` | `buildSpawnOpts()`                   | Pure Session-to-SpawnOpts mapping; could support dry-run/preview features                                    |

`handleReEnqueue` could go into `session-control-handlers.ts` (it's a post-exit control decision) or stay as a private method. If extracted, the 7-field struct is a reasonable price for testability.

`cleanupResources` and `determineExitStatus` should remain private methods — their value is organizational clarity within the class, not independent reusability.

---

## Round 3: onData() and start() Decomposition

### onData() Analysis

**Total lines**: 218 (lines 374-592)

#### Block 1: Line buffer management (lines 376-383, ~8 lines)

- `this.*` dependencies:
  - Reads: `this.dataBuffer`, `this.logWriter`
  - Writes: `this.dataBuffer` (remainder after split)
- **Cross-cutting complication**: `this.dataBuffer` is also read+written by `transitionTo()` (line 750-752). When transitioning to `awaiting_input`, `transitionTo` flushes any trailing text stuck in `dataBuffer` that lacks a final `\n`. This is needed because Gemini's ACP adapter may not emit a trailing newline. So the buffer has **two consumers**: `onData` (normal path) and `transitionTo` (flush-on-idle path).
- **Could this become a `StreamLineParser` class?** Technically yes: `parser.feed(chunk) → string[]` returning complete lines, with a `parser.flush() → string | null` for the trailing fragment. The interface is clean:
  ```typescript
  class StreamLineParser {
    feed(chunk: string): string[]; // returns complete lines
    flush(): string | null; // returns remaining buffer, clears it
  }
  ```
  However, there are two arguments against it:
  1. **The `transitionTo` flush coupling**: `transitionTo()` would need a reference to the parser to call `parser.flush()`. Currently `this.dataBuffer` is a simple string field read directly. Introducing a class object adds indirection for a 3-line flush.
  2. **Total code is 8 lines**: The buffer+split+pop pattern is 3 lines of code. Wrapping it in a class adds a file, a constructor, two methods, and an import for something that saves zero lines in `onData` (it replaces 3 lines with 1 call + still needs the log write).
  3. **No reuse**: No other code in the project buffers NDJSON lines. `execution-runner.ts` does not use line buffering (fire-and-forget).
- **Verdict: Stay inline**
- **Reason**: 8 lines total, 3 lines of actual logic, no reuse, and the `transitionTo` flush coupling means the buffer cannot be fully encapsulated without leaking the parser reference to a second consumer. The juice is not worth the squeeze.

---

#### Block 2: Pre-adapter pre-processing (lines 406-428, ~23 lines)

- `this.*` dependencies:
  - Reads: `this.approvalHandler`, `this.activeToolUseIds`
  - Writes: `this.lastAssistantUuid`
- Two sub-blocks:
  1. **Human response block detection** (lines 416-422): `parsed.type === 'user'` → extract `message.content` → `this.approvalHandler.checkForHumanResponseBlocks(content, activeToolUseIds)`. This detects when Claude's CLI tried to handle an interactive tool (AskUserQuestion, ExitPlanMode) natively but failed in pipe mode, so the tool-end suppression below can catch the resulting error.
  2. **Assistant UUID capture** (lines 424-428): `parsed.type === 'assistant' && typeof parsed.uuid === 'string'` → store in `this.lastAssistantUuid`. Used later by the `enrichedPartial` block to attach `messageUuid` to `agent:result` for frontend branching.
- **Both checks are Claude-specific**: They rely on Claude's NDJSON output format (`parsed.type === 'user'` / `parsed.type === 'assistant'`). Codex and Gemini adapters define `adapter.mapJsonToEvents`, which means they produce events from entirely different JSON structures. These two checks run on every parsed line for all adapters but are no-ops for Codex/Gemini (they never emit those types).
- **Extractable?** Yes, via an adapter hook. The natural home is `adapter.preProcessLine?(parsed, context)` where `context` provides `checkForHumanResponseBlocks` and a `setLastAssistantUuid` callback. Only the Claude adapter would implement it. This removes 12 lines of Claude-specific logic from the generic `onData` path and eliminates wasteful no-op calls for Codex/Gemini.
- **Alternative**: Fold both checks into `mapClaudeJsonToEvents` as side-effects (the mapper already receives callbacks). The UUID capture could be a new callback `onAssistantUuid?(uuid: string)`, and the human-response check could be `onUserBlock?(content: Array<...>)`. This keeps it in the existing mapper rather than adding a new adapter hook.
- **Verdict: External module** (move into adapter layer)
- **Proposed approach**: Extend `ClaudeEventMapperCallbacks` with two new optional callbacks:
  ```typescript
  interface ClaudeEventMapperCallbacks {
    // ... existing callbacks ...
    /** Called when a 'user' block is seen — for interactive tool failure detection. */
    onUserBlock?(content: Array<Record<string, unknown>>): void;
    /** Called when an 'assistant' block contains a UUID — for branch support. */
    onAssistantUuid?(uuid: string): void;
  }
  ```
  Then `mapClaudeJsonToEvents` calls these at the top of the function, and `onData` no longer has any Claude-specific pre-processing.

---

#### Block 3: Adapter mapping call (lines 430-473, ~43 lines)

- `this.*` dependencies:
  - Reads: `this.adapter.mapJsonToEvents`, `this.activityTracker`, `this.lastPerCallContextStats`, `this.lastContextWindow`, `this.session.id`
  - Writes: `this.lastPerCallContextStats` (via `onMessageStart` callback)
  - Calls: `this.activityTracker.clearDeltaBuffers()`, `.appendDelta()`, `.appendThinkingDelta()`, `this.emitEvent()`, `db.update()`
- **Structure**: A try-catch block that calls either `adapter.mapJsonToEvents(parsed)` (Codex/Gemini) or `mapClaudeJsonToEvents(parsed, callbacks)` (Claude fallback). The Claude path passes 5 inline callbacks.
- **The callbacks are the complexity**: The 5 callbacks wire `mapClaudeJsonToEvents` to SessionProcess state:
  1. `clearDeltaBuffers` → `this.activityTracker.clearDeltaBuffers()`
  2. `appendDelta` → `this.activityTracker.appendDelta(text)`
  3. `appendThinkingDelta` → `this.activityTracker.appendThinkingDelta(text)`
  4. `onMessageStart` → stores `this.lastPerCallContextStats`, emits `agent:usage` event
  5. `onResultStats` → fire-and-forget DB update for cost/turn stats
- **Could the callbacks be an interface, making this `private mapLineToEvents(parsed)`?** Yes, but the gain is marginal. The method would still need all 5 callbacks from `this.*`. As a private helper:
  ```typescript
  private mapLineToEvents(parsed: Record<string, unknown>): AgendoEventPayload[]
  ```
  This would encapsulate the adapter dispatch + callbacks, but the 43 lines would just move from one private method to another in the same file. The real complexity (the 5 Claude callbacks) would still reference `this.*`. The extraction reduces `onData` line count but does not improve testability or reuse.
- **The `onMessageStart` callback has a subtle side-effect**: It not only stores `lastPerCallContextStats` but also emits an `agent:usage` event via `this.emitEvent()`. This means the "mapping" step has an emission side-effect, which breaks the assumption that mapping is pure. This is a known wart but not a blocking issue.
- **Verdict: Private helper** (borderline stay-inline)
- **Reason**: Extracting to `private mapLineToEvents(parsed)` would reduce `onData` by ~40 lines and give the block a name, improving readability. But it does not improve testability (still needs `this.*` state) and does not enable reuse. Worth doing if `onData` is still too long after Block 4 extraction; otherwise leave inline.

---

#### Block 4: Per-event processing loop (lines 475-585, ~110 lines)

- `this.*` dependencies:
  - Reads: `this.activeToolUseIds`, `this.activeToolInfo`, `this.approvalHandler`, `this.lastPerCallContextStats`, `this.lastAssistantUuid`, `this.teamManager`, `this.sessionRef`, `this.session.id`, `this.lastContextWindow`, `this.interruptInProgress`, `this.activityTracker`
  - Writes: `this.activeToolUseIds` (add/delete), `this.activeToolInfo` (set/delete), `this.sessionRef`, `this.lastContextWindow`
  - Calls: `this.approvalHandler.suppressToolStart()`, `.isSuppressedToolEnd()`, `.isPendingHumanResponse()`, `this.emitEvent()`, `this.teamManager.onToolEvent()`, `this.transitionTo()`, `this.activityTracker.recordActivity()`, `db.update()`
- **Three distinct sub-phases within the loop**:
  1. **Suppression gates** (lines 475-500, ~26 lines): Three `continue` checks — APPROVAL_GATED_TOOLS tool-start suppression, suppressed tool-end matching, pending human response tool-end suppression. All delegate to `approvalHandler` methods. Already well-factored.
  2. **Enrichment + emission** (lines 502-517, ~16 lines): Build `enrichedPartial` (attach `perCallContextStats` + `messageUuid` to `agent:result`), then call `this.emitEvent()`.
  3. **Post-emit side-effects** (lines 519-584, ~65 lines): Seven independent `if` blocks keyed on `event.type`:
     - `agent:tool-start` → add to activeToolUseIds + activeToolInfo (6 lines)
     - `agent:tool-end` → delete from tracking sets (3 lines)
     - `agent:tool-start|end` → teamManager.onToolEvent() (3 lines)
     - `session:init` → persist sessionRef + model to DB (13 lines)
     - `agent:result` + modelUsage → cache lastContextWindow (8 lines)
     - `agent:result` + serverToolUse → persist web tool counters to DB (13 lines)
     - `agent:result` + !interruptInProgress → transitionTo('awaiting_input') (4 lines)
- **Could this become `private async processEvent(partial: AgendoEventPayload): Promise<void>`?** Yes, and this is the strongest extraction candidate in `onData`. The method would combine all three sub-phases. However, I recommend splitting it into **two** private methods for better separation of concerns:

  **Option A: Single `processEvent(partial)`** — 110 lines moved, `onData` becomes ~100 lines. Simplest refactor, one method handles suppression + enrichment + emission + side-effects.

  **Option B: Two methods** — `filterAndEmit(partial) → AgendoEvent | null` (suppression + enrichment + emission, ~42 lines) and `onEmittedEvent(event)` (post-emit side-effects, ~65 lines). `onData` calls `filterAndEmit` then `onEmittedEvent` if non-null. Better separation but more call overhead.

  **Recommendation: Option A (`processEvent`)** for pragmatic reasons:
  - The suppression gates use `continue` to skip the event entirely — this becomes a simple early `return` in a dedicated method.
  - The enrichment step reads `this.lastPerCallContextStats` and `this.lastAssistantUuid`, which are set by Blocks 2 and 3. In a dedicated method, these are just regular `this.*` reads.
  - The post-emit side-effects have no ordering dependencies on each other and are already independent `if` blocks.
  - Option B's `filterAndEmit` returning `AgendoEvent | null` is slightly awkward because `emitEvent` is async and the "should I suppress?" decision is synchronous.

- **Verdict: Private helper** — extract as `private async processEvent(partial: AgendoEventPayload): Promise<void>`
- **Proposed signature**:
  ```typescript
  /**
   * Filter, enrich, emit, and handle side-effects for a single event partial.
   * Called from onData's inner loop for each partial returned by the adapter mapper.
   */
  private async processEvent(partial: AgendoEventPayload): Promise<void>
  ```
- **Reason**: At 110 lines, this is the bulk of `onData`. Extracting it reduces `onData` to a ~65-line method that does: log write, buffer+split, JSON parse, pre-process, map, and for-each `processEvent(partial)`. That is a clean pipeline at the right abstraction level. The `processEvent` method encapsulates the per-event lifecycle: gate, enrich, emit, react.

---

**After decomposition, onData() would be ~65 lines** (currently 218):

- Lines 374-383: log write + buffer + split (10 lines)
- Lines 385-404: for-loop + JSON parse + fallback (20 lines)
- Lines 406-428: removed (moved to adapter callbacks per Block 2)
- Lines 430-473: adapter mapping call (~43 lines, stays inline or becomes `mapLineToEvents`)
- Lines 475-591: replaced by `for (const partial of partials) { await this.processEvent(partial); }` (~3 lines)

If Block 3 also becomes `mapLineToEvents`, `onData` drops to ~30 lines.

---

### start() Analysis

**Total lines after Round 2**: 143 (lines 225-368)

**Remaining inline blocks** (after Round 2 extractions of `claimSession`, `buildChildEnv`, `buildSpawnOpts`):

| Block                  | Lines   | Size | Description                                                   |
| ---------------------- | ------- | ---- | ------------------------------------------------------------- |
| Claim + future resolve | 237-247 | 10   | Call `claimSession()`, resolve futures on failure             |
| Log writer setup       | 249-254 | 5    | Create `FileLogWriter`, persist `logFilePath` to DB           |
| Control subscription   | 257-264 | 7    | Subscribe to PG NOTIFY, wire `onControl`                      |
| Env build call         | 266-270 | 4    | Call `buildChildEnv()`                                        |
| Gemini policy file     | 276-281 | 6    | Conditionally write TOML policy for Gemini MCP                |
| SpawnOpts call         | 283-290 | 7    | Call `buildSpawnOpts()`                                       |
| Adapter wiring         | 293-315 | 22   | Wire `setApprovalHandler`, `onSessionRef`, `onThinkingChange` |
| Spawn path selection   | 320-350 | 30   | Three-way branch: fork vs resume vs spawn                     |
| PID persistence        | 353-356 | 3    | Write PID to sessions row                                     |
| Process wiring         | 359-361 | 3    | Wire `onData` and `onExit`                                    |
| Timer startup          | 362-363 | 2    | Start heartbeat + MCP health check                            |
| Team manager startup   | 367     | 1    | `this.teamManager.start()`                                    |

**Verdict: Leave as-is** (with one signature fix)

**Rationale**: After Round 2 extractions, `start()` is now a clean **orchestration coordinator**. Each remaining inline block is either:

- A 1-7 line wiring call (not worth extracting)
- An already-extracted function call (claimSession, buildChildEnv, buildSpawnOpts)
- The spawn-path selection (30 lines of core decision logic that belongs here)

The 22-line adapter wiring block (concern 7) is the largest remaining inline section. It wires 3 callbacks, each of which closes over `this.*` state. Extracting these to a `wireAdapterCallbacks()` private method would save 22 lines but the method would just be a bag of unrelated callback setups with no cohesive purpose. Not recommended.

**One action item: parameter signature refactor**. `start()` takes 10 positional parameters — the caller (`session-runner.ts`, line 290) must pass all 10 in order. This should become a single `SessionStartOptions` struct:

```typescript
export interface SessionStartOptions {
  prompt: string;
  resumeRef?: string;
  spawnCwd?: string;
  envOverrides?: Record<string, string>;
  mcpConfigPath?: string;
  mcpServers?: AcpMcpServer[];
  initialImage?: ImageContent;
  displayText?: string;
  resumeSessionAt?: string;
  developerInstructions?: string;
}

async start(opts: SessionStartOptions): Promise<void>
```

Only one call-site: `session-runner.ts` line 290-301. Non-breaking internal refactor.

**Observation: `onThinkingChange` dual path**. The adapter wiring (line 308-315) registers `onThinkingChange(false) → transitionTo('awaiting_input')` as a callback. This duplicates the `agent:result → transitionTo('awaiting_input')` path in `onData` (line 581). The comment on line 311 explains: "Claude handles it via agent:result; for Codex/Gemini this is the only signal." Both paths are protected by `transitionTo`'s idempotency guard (`if (this.status === status) return`). This is intentional but should have cross-referencing comments at both sites.

---

### Summary Table

| Block                               | Method   | Verdict                       | New location                                                                     |
| ----------------------------------- | -------- | ----------------------------- | -------------------------------------------------------------------------------- |
| Block 1: Line buffer                | `onData` | **Stay inline**               | N/A (8 lines, `transitionTo` also reads buffer)                                  |
| Block 2: Pre-adapter pre-processing | `onData` | **External module**           | `ClaudeEventMapperCallbacks` — add `onUserBlock` + `onAssistantUuid` callbacks   |
| Block 3: Adapter mapping call       | `onData` | **Private helper** (optional) | `private mapLineToEvents(parsed)` — borderline, do only if onData still too long |
| Block 4: Per-event processing loop  | `onData` | **Private helper**            | `private async processEvent(partial: AgendoEventPayload): Promise<void>`         |
| Parameter signature                 | `start`  | **Refactor**                  | `SessionStartOptions` interface in same file                                     |
| Remaining start() body              | `start`  | **Stay inline**               | N/A (clean orchestration coordinator after Round 2)                              |

### Implementation order for workstream-a

1. **Extract `processEvent()`** (Block 4) — highest impact, reduces `onData` from 218 to ~65 lines, zero risk (pure method move within same class)
2. **Refactor `start()` signature** to `SessionStartOptions` — mechanical, update `start()` + `session-runner.ts` call-site
3. **Move pre-processing into `ClaudeEventMapperCallbacks`** (Block 2) — add 2 callbacks to the mapper interface, implement in `mapClaudeJsonToEvents`, remove 12 lines from `onData`
4. **(Optional) Extract `mapLineToEvents()`** (Block 3) — only if `onData` is still >80 lines after steps 1+3; otherwise skip
