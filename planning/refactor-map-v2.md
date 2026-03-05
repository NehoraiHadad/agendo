## session-process

### Handler Boundary Analysis of session-process.ts

**File**: `src/lib/worker/session-process.ts`
**Lines**: 1,193

**Already extracted**: `approval-handler.ts` (317 lines), `activity-tracker.ts` (291 lines), `session-control-handlers.ts` (192 lines), `session-team-manager.ts` (331 lines), `interruption-marker.ts` (53 lines). Total satellite code: 1,184 lines.

---

#### Violations Found

1. **`onData` — Claude-specific event enrichment and DB side-effects** (lines 536–646)
   - Description: After `mapJsonToEvents` returns `AgendoEventPayload[]`, session-process.ts runs a 110-line gauntlet of post-processing: approval-gated tool suppression (lines 539–561), agent:result enrichment with `perCallContextStats`/`messageUuid` (lines 567–576), in-flight tool tracking (lines 582–592), team lifecycle detection (lines 595–597), session:init ref/model persistence (lines 600–612), context-window caching (lines 615–622), web tool usage persistence (lines 625–637), and agent:result → awaiting_input transition (lines 642–645). This mixes event-bus dispatch logic with DB writes, approval state, and adapter-specific enrichment.
   - Belongs in: An **event dispatcher** module that receives raw `AgendoEventPayload[]` and runs a pipeline of handlers.
   - Extraction: `src/lib/worker/event-dispatcher.ts`

2. **`onData` — Claude-specific `type==='user'` interactive tool detection** (lines 477–483)
   - Description: Checks `parsed.type === 'user'` with `is_error:true` tool_results to detect failed interactive tools (AskUserQuestion, ExitPlanMode). This is a Claude stream-json protocol detail — it inspects raw parsed JSON before event mapping. It should be inside `mapClaudeJsonToEvents` or a pre-processing hook, not in session-process.
   - Belongs in: `claude-event-mapper.ts` (as a pre-map hook) or in `approval-handler.ts` via a callback from the mapper.
   - Extraction: Move into `mapClaudeJsonToEvents` callbacks or add a `preMapHook` on the adapter interface.

3. **`onData` — `mapClaudeJsonToEvents` callback closures** (lines 493–527)
   - Description: The `mapClaudeJsonToEvents` call receives 4 inline callback closures (`clearDeltaBuffers`, `appendDelta`, `appendThinkingDelta`, `onMessageStart`, `onResultStats`) that reach into `this.activityTracker`, `this.lastPerCallContextStats`, `this.lastContextWindow`, and perform DB writes. These callbacks embed session-process state management inside a supposedly pure event-mapping function.
   - Belongs in: The mapper should return structured side-effects (e.g. `{ events, messageStartStats?, resultStats? }`) and let the caller apply them. Or these callbacks should be a formal `MapperContext` interface.
   - Extraction: Define a `MapperContext` interface in `adapters/types.ts`; session-process provides an implementation.

4. **`onData` — `lastAssistantUuid` tracking** (lines 487–489)
   - Description: Claude-specific: captures `parsed.uuid` from `type==='assistant'` messages for branching support (`--resume-session-at`). This is a Claude stream-json protocol detail that other adapters don't produce.
   - Belongs in: `claude-event-mapper.ts` — could be returned as metadata alongside events.
   - Extraction: Return `assistantUuid` as part of the mapper result.

5. **`onControl` — tool-approval mega-block** (lines 693–779)
   - Description: The `tool-approval` branch of `onControl` is 86 lines and handles 4 sub-flows: clearContextRestart (ExitPlanMode option 1), structured decisions with updatedInput/rememberForSession, allow-session tool persistence, and post-approval side-effects (mode change, compact). This is the single largest inline control handler that was NOT moved to `session-control-handlers.ts`.
   - Belongs in: `session-control-handlers.ts` as `handleToolApproval()`.
   - Extraction: Extract to `handleToolApproval(control, ctx)` in `session-control-handlers.ts`.

6. **`onControl` — message handler with image reading** (lines 674–690)
   - Description: The `message` control handler reads a file from disk (`readFileSync`), decodes base64, and cleans up the temp file. This mixes I/O concerns with control dispatch.
   - Belongs in: A helper function (e.g. `loadControlImage`) or in `session-control-handlers.ts`.
   - Extraction: Extract `loadControlImage(imageRef)` to a utility, or move the whole handler to `session-control-handlers.ts` as `handleMessage()`.

7. **`onExit` — exit status determination + re-enqueue logic** (lines 939–1107)
   - Description: 168-line method that handles: guard against double-invocation, timer cleanup, approval drain, team manager stop, policy file cleanup, control channel unsubscribe, mid-turn interruption detection + event recording, exit-code-to-status mapping (cancel/idle/ended), endedAt persistence, mode-change re-enqueue, clearContextRestart re-enqueue, mid-turn auto-resume re-enqueue, and log writer close. Three distinct responsibilities: (a) resource cleanup (lines 943–977), (b) status determination + DB writes (lines 979–1044), (c) re-enqueue logic (lines 1046–1099).
   - Belongs in: Split into `cleanupResources()`, `determineExitStatus()`, and `handleReEnqueue()` — either as private methods or extracted functions.
   - Extraction: Could stay as private methods (lower risk) or move to `session-control-handlers.ts`.

8. **`start()` method — 200+ lines of spawn orchestration** (lines 222–429)
   - Description: Handles atomic DB claim, log writer setup, PG NOTIFY subscription, child env construction, policy file generation, spawn opts assembly, adapter wiring (approval handler, sessionRef callback, thinking callback), and three spawn modes (fork/resume/spawn). This is a god-method that does setup, wiring, and process launch all in one.
   - Belongs in: Could be split into `claimSession()`, `buildSpawnOpts()`, `wireAdapterCallbacks()`, and the actual spawn call.
   - Extraction: Private helper methods within SessionProcess (low risk).

9. **Constructor — 70 lines of dependency wiring** (lines 129–202)
   - Description: The constructor instantiates `ApprovalHandler`, `SessionTeamManager`, and `ActivityTracker` with complex callback closures that reach into `this.*`. This is initialization code that could be cleaner if the dependencies used a shared context interface.
   - Belongs in: Acceptable as-is, but could be simplified with a `SessionContext` interface that all sub-managers receive.
   - Extraction: Low priority. Define `SessionContext` interface for shared access.

10. **`emitEvent` — DB write per event** (lines 1119–1143)
    - Description: Every single event triggers a DB write to update `sessions.eventSeq`. This is a hot path — called dozens of times per turn. The responsibility of sequence tracking is mixed with event publishing.
    - Belongs in: Could batch seq updates or decouple with a write-behind queue. Not a boundary violation per se, but a performance concern worth noting.
    - Extraction: Consider batching via `ActivityTracker` heartbeat (write eventSeq every 30s instead of every event).

---

#### Dependency Graph: Key Handlers

**`onData` (lines 435–653)** reads/writes:

- Reads: `this.logWriter`, `this.dataBuffer`, `this.adapter.mapJsonToEvents`, `this.activityTracker`, `this.lastPerCallContextStats`, `this.lastContextWindow`, `this.lastAssistantUuid`, `this.activeToolUseIds`, `this.activeToolInfo`, `this.approvalHandler`, `this.teamManager`, `this.session`, `this.interruptInProgress`
- Writes: `this.dataBuffer`, `this.lastPerCallContextStats`, `this.lastContextWindow`, `this.lastAssistantUuid`, `this.activeToolUseIds`, `this.activeToolInfo`, `this.sessionRef`
- Calls: `this.emitEvent()`, `this.transitionTo()`, `this.activityTracker.recordActivity()`, `this.activityTracker.clearDeltaBuffers()`, `this.activityTracker.appendDelta()`, `this.approvalHandler.checkForHumanResponseBlocks()`, `this.approvalHandler.suppressToolStart()`, `this.approvalHandler.isSuppressedToolEnd()`, `this.approvalHandler.isPendingHumanResponse()`, `this.teamManager.onToolEvent()`, DB writes (sessions table)

**`onControl` (lines 659–806)** reads/writes:

- Reads: `this.status`, `this.approvalHandler`, `this.session`, `this.adapter`, `this.managedProcess`, `this.activityTracker`, `this.activeToolUseIds`, `this.sigkillTimers`, `this.spawnCwd`
- Writes: `this.cancelKilled`, `this.terminateKilled`, `this.clearContextRestart`, `this.clearContextRestartNewSessionId`, `this.modeChangeRestart`, `this.interruptInProgress`
- Calls: `handleCancel()`, `handleInterrupt()`, `this.pushMessage()`, `this.approvalHandler.takeResolver()`, `this.approvalHandler.pushToolResult()`, `this.approvalHandler.takeQuestions()`, `this.approvalHandler.persistAllowedTool()`, `this.approvalHandler.drain()`, `handleSetPermissionMode()`, `handleSetModel()`, `this.adapter.steer()`, `this.adapter.rollback()`, `this.emitEvent()`, `this.makeCtrl()`

**`onExit` (lines 939–1107)** reads/writes:

- Reads: `this.exitHandled`, `this.sessionStartTime`, `this.status`, `this.terminateKilled`, `this.cancelKilled`, `this.modeChangeRestart`, `this.clearContextRestart`, `this.clearContextRestartNewSessionId`, `this.sessionRef`, `this.session`, `this.activeToolInfo`, `this.policyFilePath`, `this.activityTracker`, `this.sigkillTimers`, `this.approvalHandler`, `this.teamManager`, `this.logWriter`, `this.unsubscribeControl`
- Writes: `this.exitHandled`, `this.sigkillTimers`, `this.policyFilePath`, `this.unsubscribeControl`, `this.logWriter`
- Calls: `this.slotReleaseFuture.resolve()`, `this.activityTracker.stopAllTimers()`, `this.approvalHandler.drain()`, `this.teamManager.stop()`, `this.emitEvent()`, `this.transitionTo()`, `recordInterruptionEvent()`, `enqueueSession()`, `this.exitFuture.resolve()`, DB writes

---

#### Inline `onControl` Sub-Handlers (line ranges)

| Control Type          | Lines   | Size | Extracted?                           |
| --------------------- | ------- | ---- | ------------------------------------ |
| `cancel`              | 670–671 | 2    | Yes (delegates to `handleCancel`)    |
| `interrupt`           | 672–673 | 2    | Yes (delegates to `handleInterrupt`) |
| `message`             | 674–690 | 17   | No — inline with image I/O           |
| `redirect`            | 691–692 | 2    | Trivial (1 call)                     |
| `tool-approval`       | 693–779 | 87   | **No — largest inline block**        |
| `tool-result`         | 780–788 | 9    | No — delegates to approvalHandler    |
| `answer-question`     | 789–796 | 8    | No — delegates to approvalHandler    |
| `set-permission-mode` | 797–798 | 2    | Yes (delegates)                      |
| `set-model`           | 799–800 | 2    | Yes (delegates)                      |
| `steer`               | 801–802 | 2    | Trivial                              |
| `rollback`            | 803–804 | 2    | Trivial                              |

---

#### Recommended Extractions

| #   | Module                                 | Source Lines                  | Responsibility                                                                                      | Risk   |
| --- | -------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| 1   | `session-control-handlers.ts` (extend) | 693–779                       | `handleToolApproval()` — clearContextRestart, decision resolution, post-approval side-effects       | Low    |
| 2   | `session-control-handlers.ts` (extend) | 674–690                       | `handleMessage()` — image loading + pushMessage                                                     | Low    |
| 3   | `event-dispatcher.ts` (new)            | 536–646                       | Post-map event pipeline: suppression, enrichment, tool tracking, DB side-effects, state transitions | Medium |
| 4   | Private methods in SessionProcess      | 943–977, 1006–1037, 1046–1099 | `onExit` split: `cleanupResources()`, `determineExitStatus()`, `handleReEnqueue()`                  | Low    |
| 5   | Private methods in SessionProcess      | 240–325                       | `start()` split: `claimSession()`, `buildChildEnv()`, `buildSpawnOpts()`                            | Low    |
| 6   | Mapper context interface               | 493–527                       | Formalize `MapperContext` to replace inline closures in mapClaudeJsonToEvents call                  | Low    |
| 7   | `emitEvent` batching                   | 1119–1143                     | Decouple eventSeq DB writes from hot-path emission                                                  | Medium |

---

#### Interfaces to Define

```typescript
/** Formal context for event mappers (replaces inline closures in onData). */
export interface MapperContext {
  clearDeltaBuffers(): void;
  appendDelta(text: string): void;
  appendThinkingDelta(text: string): void;
  onMessageStart(stats: {
    inputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }): void;
  onResultStats(costUsd: number | null, turns: number | null): void;
}

/** Extended SessionControlCtx fields needed for tool-approval handler. */
export interface ToolApprovalControlCtx extends SessionControlCtx {
  clearContextRestartNewSessionId: string | null;
  spawnCwd: string | null;
  setClearContextRestart(v: boolean): void;
  setClearContextRestartNewSessionId(id: string | null): void;
  pushMessage(text: string): Promise<void>;
}

/** Return type from an event dispatcher pipeline step. */
export interface DispatchResult {
  emitted: boolean;
  /** Whether downstream handlers should continue processing. */
  suppress: boolean;
}
```

---

#### Risk Assessment

**Low risk (safe to do now):**

- Extract `handleToolApproval()` to `session-control-handlers.ts` (pure refactor, same pattern as existing `handleCancel`/`handleInterrupt`)
- Extract `handleMessage()` to `session-control-handlers.ts`
- Split `onExit` into private helper methods (no public API change)
- Split `start()` into private helper methods
- Define `MapperContext` interface (non-breaking, just formalizes existing closures)

**Medium risk (needs careful testing):**

- Extract `event-dispatcher.ts` — the post-map pipeline has deep coupling to `this.*` state (activeToolUseIds, approvalHandler, teamManager, contextStats). Requires careful design of the dispatch context to avoid passing 15 fields.
- `emitEvent` batching — changes the consistency guarantee (events could be "lost" if process crashes between batch writes). Must ensure the heartbeat flush covers edge cases.

**High risk (defer):**

- Moving Claude-specific `parsed.type === 'user'` detection into the adapter — this interleaves with approval-handler state that lives outside the adapter. Would require the adapter to return structured "side-effect" descriptors instead of the current callback-based approach.

---

#### Projected Line Count After Extraction

| Change                                     | Lines moved out                          |
| ------------------------------------------ | ---------------------------------------- |
| `handleToolApproval()` to control-handlers | ~90                                      |
| `handleMessage()` to control-handlers      | ~20                                      |
| `onExit` split into private methods        | 0 (stays in file, just better structure) |
| `start()` split into private methods       | 0 (stays in file)                        |
| `event-dispatcher.ts` extraction           | ~110                                     |
| MapperContext interface (in types.ts)      | ~15 added elsewhere                      |

**Current**: 1,193 lines
**After low-risk extractions**: ~1,083 lines (-110)
**After medium-risk extractions**: ~973 lines (-220)

## services

### Service Layer Duplication Analysis

#### Duplicated Patterns

1. **`createSession` + `enqueueSession` call pairs in plan-service.ts**

   The same two-step pattern (create a session row, then enqueue it) is repeated **4 times** in `plan-service.ts`:

   | Function                  | `createSession` line | `enqueueSession` line | Work between calls                                                   |
   | ------------------------- | -------------------- | --------------------- | -------------------------------------------------------------------- |
   | `executePlan()`           | 167                  | 187                   | Updates `plans` with `executingSessionId` + metadata (lines 178-185) |
   | `breakPlanIntoTasks()`    | 225                  | 235                   | None — back-to-back                                                  |
   | `startPlanConversation()` | 351                  | 366                   | Updates `plans.conversationSessionId` (lines 361-364)                |
   | `validatePlan()`          | 473                  | 492                   | Updates `plans.lastValidatedAt` + `codebaseHash` (lines 483-490)     |

   The same pattern also appears in:
   - `snapshot-service.ts` `resumeFromSnapshot()` (lines 133, 148) — no work between
   - `session-service.ts` `forkSession()` (line 124) — conditional enqueue

   **Proposed helper signature:**

   ```typescript
   interface CreateAndEnqueueSessionOpts extends CreateSessionInput {
     /** Optional callback invoked after createSession but before enqueueSession.
      *  Receives the created session. Use for linking the session to other entities. */
     beforeEnqueue?: (session: Session) => Promise<void>;
     /** Extra enqueue options (resumeSessionAt, etc.) */
     enqueueOpts?: Omit<RunSessionJobData, 'sessionId'>;
   }

   async function createAndEnqueueSession(opts: CreateAndEnqueueSessionOpts): Promise<Session>;
   ```

   - `breakPlanIntoTasks` and `resumeFromSnapshot` need no `beforeEnqueue` callback.
   - `executePlan` and `startPlanConversation` use the callback to link the session to the plan row.
   - `validatePlan` uses the callback to update `lastValidatedAt`.
   - Return type is `Session` (callers extract `session.id`).

2. **`binaryName` derivation — repeated 3 times**

   The exact same expression `agent.binaryPath.split('/').pop()?.toLowerCase() ?? ''` appears in:
   - `plan-service.ts` line 259
   - `session-runner.ts` line 131
   - `adapter-factory.ts` line 19

   **Consolidation:** Extract to a one-liner utility:

   ```typescript
   // src/lib/worker/agent-utils.ts
   export function getBinaryName(agent: { binaryPath: string }): string {
     return agent.binaryPath.split('/').pop()?.toLowerCase() ?? '';
   }
   ```

3. **Dynamic filter-building pattern (`conditions` array)**

   Five services use the same pattern: build a `conditions[]` array, then `and(...conditions)`:
   - `plan-service.ts` `listPlans()` (lines 89-96)
   - `session-service.ts` `listSessions()` (lines 267-276)
   - `task-service.ts` `listTasksByStatus()` (lines 329-345)
   - `snapshot-service.ts` `listSnapshots()` (lines 56-67)
   - `workspace-service.ts` `listWorkspaces()` (lines 41-46)

   This is a natural Drizzle pattern and is idiomatic. **Not worth extracting** — the conditions are specific to each table. Flagging for awareness only.

4. **Search functions — `ilike` on title + description/content**

   Four services have nearly identical search functions:
   - `plan-service.ts` `searchPlans()` (lines 54-63) — `ilike(plans.title)` + `ilike(plans.content)`
   - `session-service.ts` `searchSessions()` (lines 225-246) — `ilike(sessions.title)` + `ilike(sessions.initialPrompt)`
   - `task-service.ts` `searchTasks()` (lines 376-396) — `ilike(tasks.title)` + `ilike(tasks.description)` + JOIN projects
   - `project-service.ts` `searchProjects()` (lines 56-73) — `ilike(projects.name)` + `ilike(projects.description)`

   Each returns a different shape and joins different tables. **Not worth a generic helper** — the cost of parameterizing table/columns/joins would exceed the duplication cost. Flagging for awareness only.

5. **`listFreeChatsByProject` vs `listTaskSessionsByProject` — near-identical queries**

   Found in `session-service.ts`:
   - `listFreeChatsByProject()` (lines 180-197): `isNull(sessions.taskId)`
   - `listTaskSessionsByProject()` (lines 199-216): `isNotNull(sessions.taskId)`

   These two functions are identical except for the `isNull` vs `isNotNull` condition.

   **Consolidation:**

   ```typescript
   async function listSessionsByProject(
     projectId: string,
     filter: 'free-chats' | 'task-sessions',
     limit?: number,
   ): Promise<SessionWithAgent[]>;
   ```

   The internal query adds `isNull(sessions.taskId)` or `isNotNull(sessions.taskId)` based on the filter. Both callers already pass a string constant, so migration is trivial.

6. **`updatedAt: new Date()` in update operations**

   Repeated across every service's update function (14+ occurrences across the codebase). This is a standard Drizzle pattern and is **not worth abstracting** — it's explicit and clear. A database trigger would centralize it but add hidden behavior. Flagging for awareness only.

7. **`validateBinaryPath` vs `validateBinary`**

   Two similar binary-path validation functions:
   - `agent-service.ts` `validateBinaryPath()` (lines 47-56) — uses `accessSync(path, X_OK)`, throws `ValidationError`
   - `worker/safety.ts` `validateBinary()` (line 38) — different implementation, used by session-runner

   These serve different purposes (agent registration vs session spawn) and have different error types. **Low priority** — could share core logic but the divergence is intentional.

#### Process-Utils Extraction Candidates

Functions in worker files that should move to shared utility modules:

| Function/Block            | Current Location                                                        | Lines       | Proposed Location                | Reason                                                                                  |
| ------------------------- | ----------------------------------------------------------------------- | ----------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `binaryName` derivation   | `session-runner.ts:131`, `adapter-factory.ts:19`, `plan-service.ts:259` | 1 line each | `src/lib/worker/agent-utils.ts`  | Repeated 3x with identical logic                                                        |
| `interpolatePrompt()`     | `session-runner.ts:37-48`                                               | 37-48       | `src/lib/worker/prompt-utils.ts` | General-purpose template interpolation, could be reused by plan-service prompt building |
| `getGitHead()`            | `plan-service.ts:377-384`                                               | 377-384     | `src/lib/utils/git.ts`           | Pure utility, could be reused by snapshot-service or dashboard                          |
| `resolveSessionLogPath()` | `session-process.ts:52-57`                                              | 52-57       | Stay in place                    | Only used by SessionProcess, no duplication                                             |

#### Plan-Service Deduplication

Overlap between `plan-service.ts` and other services:

1. **Session creation orchestration** — `plan-service.ts` directly calls `createSession()` from `session-service.ts` and `enqueueSession()` from `queue.ts` in 4 separate functions. This is the primary duplication site (see pattern #1 above). The `createAndEnqueueSession` helper would eliminate ~40 lines across the 4 call sites.

2. **Agent binary detection** — `plan-service.ts` line 259 derives `binaryName` from `agent.binaryPath` to branch on Claude/Codex/Gemini behavior. This same logic lives in `session-runner.ts` and `adapter-factory.ts`. Extracting `getBinaryName()` removes the duplication.

3. **Plan update side-effects** — `executePlan()`, `startPlanConversation()`, and `validatePlan()` all do a `db.update(plans).set({...})` after creating the session to link it or record metadata. These updates are too specific to generalize — they should stay as the `beforeEnqueue` callback.

4. **No overlap with task-service.ts** — `plan-service.ts` calls `createTask()` once (in `executePlan`, line 140) but doesn't duplicate any task query logic.

5. **No overlap with session-service query functions** — `plan-service.ts` only calls `createSession()`, never the list/search/delete functions.

#### Recommended New Files

| New File                              | Extracts From                                                           | Purpose                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/lib/worker/agent-utils.ts`       | `plan-service.ts:259`, `session-runner.ts:131`, `adapter-factory.ts:19` | `getBinaryName(agent)` utility                                                       |
| `src/lib/utils/git.ts`                | `plan-service.ts:377-384`                                               | `getGitHead()` — reusable git helper                                                 |
| `src/lib/services/session-helpers.ts` | `plan-service.ts` (4 sites), `snapshot-service.ts` (1 site)             | `createAndEnqueueSession()` helper combining create + optional side-effect + enqueue |

**Not recommended:**

- A generic `buildWhereConditions()` helper — the filter-building pattern is idiomatic Drizzle and each service's conditions are table-specific
- A generic `searchEntity()` helper — each search function joins different tables and returns different shapes
- A `touchUpdatedAt()` helper — too trivial to abstract

#### Risk Assessment

**Low risk:**

- Extracting `getBinaryName()` — pure function, no side effects, trivial migration
- Extracting `getGitHead()` — pure function, already isolated
- Merging `listFreeChatsByProject` + `listTaskSessionsByProject` — identical logic with a simple flag

**Medium risk:**

- `createAndEnqueueSession()` helper — touches the critical session-creation path. Must preserve:
  - The `beforeEnqueue` callback ordering (plan row updates MUST happen before enqueue)
  - Error handling if `beforeEnqueue` fails (should not leave an orphaned session)
  - The return type (callers use `session.id` and sometimes the full `Session` object)
  - Conditional enqueue in `forkSession()` (only enqueues when `parent.sessionRef && initialPrompt`)

**Not recommended to change:**

- The 5 `conditions[]` filter-building sites — idiomatic, no real duplication
- The 4 search functions — each is sufficiently different
- `validateBinaryPath` vs `validateBinary` — different error semantics and callers

## routes

### Route Validation and DB Call Audit

Audited all 65 route files under `src/app/api/`. Focused on: missing `assertUUID` calls on dynamic `[id]`/`[capId]` params, direct DB calls that bypass the service layer, and business logic that belongs in services.

---

#### Missing assertUUID Calls

Routes with dynamic UUID params (`[id]`, `[capId]`) that do NOT call `assertUUID` before using the param:

| Route File                                                       | Param | Line | Fix                                                                         |
| ---------------------------------------------------------------- | ----- | ---- | --------------------------------------------------------------------------- |
| `src/app/api/sessions/[id]/cancel/route.ts`                      | id    | 12   | Add `assertUUID(id, 'Session')`                                             |
| `src/app/api/sessions/[id]/interrupt/route.ts`                   | id    | 12   | Add `assertUUID(id, 'Session')`                                             |
| `src/app/api/sessions/[id]/message/route.ts`                     | id    | 15   | Add `assertUUID(id, 'Session')`                                             |
| `src/app/api/sessions/[id]/control/route.ts`                     | id    | 29   | Add `assertUUID(id, 'Session')`                                             |
| `src/app/api/sessions/[id]/events/route.ts` (GET)                | id    | 26   | Add `assertUUID(id, 'Session')` -- NOTE: not wrapped in `withErrorBoundary` |
| `src/app/api/sessions/[id]/events/route.ts` (POST)               | id    | 107  | Add `assertUUID(id, 'Session')`                                             |
| `src/app/api/sessions/[id]/logs/stream/route.ts`                 | id    | 13   | Add `assertUUID(id, 'Session')` -- NOTE: not wrapped in `withErrorBoundary` |
| `src/app/api/agents/[id]/route.ts` (GET)                         | id    | 19   | Add `assertUUID(id, 'Agent')`                                               |
| `src/app/api/agents/[id]/route.ts` (PATCH)                       | id    | 27   | Add `assertUUID(id, 'Agent')`                                               |
| `src/app/api/agents/[id]/route.ts` (DELETE)                      | id    | 37   | Add `assertUUID(id, 'Agent')`                                               |
| `src/app/api/agents/[id]/capabilities/route.ts` (GET)            | id    | 17   | Add `assertUUID(id, 'Agent')`                                               |
| `src/app/api/agents/[id]/capabilities/route.ts` (POST)           | id    | 25   | Add `assertUUID(id, 'Agent')`                                               |
| `src/app/api/agents/[id]/capabilities/[capId]/route.ts` (PATCH)  | capId | 19   | Add `assertUUID(capId, 'Capability')`                                       |
| `src/app/api/agents/[id]/capabilities/[capId]/route.ts` (DELETE) | capId | 29   | Add `assertUUID(capId, 'Capability')`                                       |
| `src/app/api/agents/[id]/refresh-flags/route.ts`                 | id    | 8    | Add `assertUUID(id, 'Agent')`                                               |
| `src/app/api/tasks/[id]/subtasks/route.ts`                       | id    | 7    | Add `assertUUID(id, 'Task')`                                                |
| `src/app/api/tasks/[id]/reorder/route.ts`                        | id    | 14   | Add `assertUUID(id, 'Task')`                                                |
| `src/app/api/tasks/[id]/dependencies/route.ts` (GET)             | id    | 13   | Add `assertUUID(id, 'Task')`                                                |
| `src/app/api/tasks/[id]/dependencies/route.ts` (POST)            | id    | 26   | Add `assertUUID(id, 'Task')`                                                |
| `src/app/api/tasks/[id]/dependencies/route.ts` (DELETE)          | id    | 40   | Add `assertUUID(id, 'Task')`                                                |
| `src/app/api/tasks/[id]/events/route.ts` (GET)                   | id    | 7    | Add `assertUUID(id, 'Task')`                                                |
| `src/app/api/tasks/[id]/events/route.ts` (POST)                  | id    | 26   | Add `assertUUID(id, 'Task')`                                                |

**Routes that already have `assertUUID`** (no changes needed):

| Route File                                                  | Param                 |
| ----------------------------------------------------------- | --------------------- |
| `src/app/api/sessions/[id]/route.ts` (GET, PATCH, DELETE)   | id                    |
| `src/app/api/sessions/[id]/mode/route.ts`                   | id                    |
| `src/app/api/sessions/[id]/model/route.ts`                  | id                    |
| `src/app/api/sessions/[id]/fork/route.ts`                   | id                    |
| `src/app/api/sessions/[id]/plan/route.ts`                   | id                    |
| `src/app/api/sessions/[id]/team-message/route.ts`           | id                    |
| `src/app/api/sessions/[id]/memory/route.ts`                 | id (via `getSession`) |
| `src/app/api/tasks/[id]/route.ts` (GET, PATCH, DELETE)      | id                    |
| `src/app/api/projects/[id]/route.ts` (GET, PATCH, DELETE)   | id                    |
| `src/app/api/projects/[id]/restore/route.ts`                | id                    |
| `src/app/api/projects/[id]/purge/route.ts`                  | id                    |
| `src/app/api/projects/[id]/sessions/route.ts`               | id                    |
| `src/app/api/plans/[id]/route.ts` (GET, PATCH, DELETE)      | id                    |
| `src/app/api/plans/[id]/validate/route.ts`                  | id                    |
| `src/app/api/plans/[id]/execute/route.ts`                   | id                    |
| `src/app/api/plans/[id]/breakdown/route.ts`                 | id                    |
| `src/app/api/plans/[id]/conversation/route.ts` (GET, POST)  | id                    |
| `src/app/api/snapshots/[id]/route.ts` (GET, PATCH, DELETE)  | id                    |
| `src/app/api/snapshots/[id]/resume/route.ts`                | id                    |
| `src/app/api/workspaces/[id]/route.ts` (GET, PATCH, DELETE) | id                    |

---

#### Direct DB Calls in Routes (should be in services)

1. **`src/app/api/sessions/[id]/route.ts` GET** (lines 15-30)
   - DB operation: `db.select().from(sessions).leftJoin(agents).leftJoin(agentCapabilities).leftJoin(tasks).leftJoin(projects).where(eq(sessions.id, id))`
   - Complex join query to fetch session with agent name, capability label, task title, project name
   - Move to: `src/lib/services/session-service.ts` as `getSessionWithDetails(id: string)`
   - Note: DELETE already uses `deleteSession()` from session-service, but GET and PATCH do not

2. **`src/app/api/sessions/[id]/route.ts` PATCH** (lines 59-63)
   - DB operation: `db.update(sessions).set({ title }).where(eq(sessions.id, id))`
   - Move to: `src/lib/services/session-service.ts` as `updateSessionTitle(id: string, title: string | null)`

3. **`src/app/api/sessions/[id]/cancel/route.ts` POST** (lines 14-23)
   - DB operation: `db.update(sessions).set({ status: 'ended', endedAt }).where(and(eq(sessions.id, id), inArray(sessions.status, ['active', 'awaiting_input'])))`
   - Business logic: status transition guard + PG NOTIFY publish
   - Move to: `src/lib/services/session-service.ts` as `cancelSession(id: string)`

4. **`src/app/api/sessions/[id]/interrupt/route.ts` POST** (lines 14-18)
   - DB operation: `db.select().from(sessions).where(and(eq(sessions.id, id), eq(sessions.status, 'active')))`
   - Business logic: active-status guard + PG NOTIFY
   - Move to: `src/lib/services/session-service.ts` as `interruptSession(id: string)`

5. **`src/app/api/sessions/[id]/mode/route.ts` PATCH** (lines 36-44)
   - DB operation: `db.update(sessions).set({ permissionMode: mode }).where(eq(sessions.id, id))`
   - Business logic: mode validation + PG NOTIFY publish to worker
   - Move to: `src/lib/services/session-service.ts` as `setSessionPermissionMode(id: string, mode: PermissionMode)`

6. **`src/app/api/sessions/[id]/model/route.ts` PATCH** (lines 30-38)
   - DB operation: `db.update(sessions).set({ model }).where(eq(sessions.id, id))`
   - Business logic: model validation + PG NOTIFY publish to worker
   - Move to: `src/lib/services/session-service.ts` as `setSessionModel(id: string, model: string)`

7. **`src/app/api/sessions/[id]/events/route.ts` GET** (line 35)
   - DB operation: `db.select().from(sessions).where(eq(sessions.id, id))`
   - Used to fetch session for SSE catchup (log file path, status)
   - Move to: use existing `getSession()` from session-service

8. **`src/app/api/sessions/[id]/events/route.ts` POST** (lines 110-114)
   - DB operation: `db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id))`
   - Existence check before publishing event
   - Move to: use existing `getSession()` from session-service

9. **`src/app/api/sessions/[id]/logs/stream/route.ts`** (lines 19-23, 27-31)
   - DB operations: two inline query functions passed to `createLogStreamHandler`
   - `getRecord()`: `db.select({ logFilePath, status }).from(sessions).where(...)`
   - `pollStatus()`: `db.select({ status }).from(sessions).where(...)`
   - Move to: `src/lib/services/session-service.ts` as `getSessionLogInfo(id)` and `getSessionStatus(id)`

10. **`src/app/api/sessions/[id]/control/route.ts`** (lines 114-117)
    - DB operation: `db.update(sessions).set({ permissionMode: newMode, initialPrompt }).where(eq(sessions.id, id))`
    - Business logic: ExitPlanMode idle resume -- updates mode + prompt then enqueues
    - Move to: `src/lib/services/session-service.ts` as `resumeWithNewMode(id, mode, prompt, resumeRef)`

11. **`src/app/api/sessions/route.ts` POST** (lines 55-59)
    - DB operation: `db.select({ interactionMode }).from(agentCapabilities).where(eq(agentCapabilities.id, body.capabilityId))`
    - Capability mode validation before creating session
    - Move to: `src/lib/services/capability-service.ts` as `assertPromptModeCapability(capabilityId)`

12. **`src/app/api/sessions/import/route.ts`** (lines 29-33, 40-58, 71-76, 98-109)
    - Multiple DB operations:
      - Check existing session by sessionRef (line 29-33)
      - Find Claude agent by slug (line 40-44)
      - Find prompt capability by agent+mode (line 50-59)
      - Find project by rootPath (line 71-76)
      - Update session with metadata (line 98-109)
    - Move to: `src/lib/services/cli-import.ts` as `importCliSession(params)` -- consolidate entire import flow

13. **`src/app/api/projects/[id]/sessions/route.ts`** (lines 30-40)
    - DB operation: `db.select({ id: agentCapabilities.id }).from(agentCapabilities).where(and(...))`
    - Capability lookup for quick-launch
    - Move to: `src/lib/services/capability-service.ts` as `findPromptCapability(agentId)`

14. **`src/app/api/stats/route.ts`** (lines 8-14)
    - DB operations: count of todo tasks, count of active sessions
    - Move to: `src/lib/services/dashboard-service.ts` as `getQuickStats()` (or extend `getDashboardStats()`)

---

#### Business Logic in Routes (should be in services)

1. **`src/app/api/sessions/[id]/control/route.ts`** (lines 52-128)
   - Complex branching logic: clearContextRestart, tool-approval on idle sessions, plan file reading, mode switching
   - This is the most logic-heavy route in the codebase (~100 lines of business logic)
   - Move to: `src/lib/services/session-service.ts` as `handleControlMessage(sessionId, control)` with sub-methods

2. **`src/app/api/sessions/[id]/message/route.ts`** (lines 22-51)
   - Cold resume logic: status checking, image saving to disk, enqueue decision
   - Hot path: image saving to disk, PG NOTIFY publish
   - Move to: `src/lib/services/session-service.ts` as `sendMessageToSession(id, message, image?)`

3. **`src/app/api/sessions/[id]/cancel/route.ts`** (lines 14-31)
   - Status transition + PG NOTIFY in one operation
   - Move to: `src/lib/services/session-service.ts` as `cancelSession(id)`

4. **`src/app/api/sessions/[id]/interrupt/route.ts`** (lines 14-27)
   - Active check + PG NOTIFY
   - Move to: `src/lib/services/session-service.ts` as `interruptSession(id)`

5. **`src/app/api/sessions/[id]/team-message/route.ts`** (lines 43-91)
   - Team inbox file manipulation: find team, build path, read/write JSON, atomic rename
   - Move to: `src/lib/services/team-service.ts` or extend `TeamInboxMonitor` with a `sendToInbox()` method

6. **`src/app/api/sessions/import/route.ts`** (lines 20-112)
   - Entire import flow: validate file, check duplicates, find agent+capability, convert JSONL, create session, update metadata
   - Move to: `src/lib/services/cli-import.ts` as `importCliSession(params)`

---

#### Missing Service Functions

Functions that routes need but don't exist in any service:

| Service File            | Function                                   | Needed By                            |
| ----------------------- | ------------------------------------------ | ------------------------------------ |
| `session-service.ts`    | `getSessionWithDetails(id)`                | `sessions/[id]/route.ts` GET         |
| `session-service.ts`    | `updateSessionTitle(id, title)`            | `sessions/[id]/route.ts` PATCH       |
| `session-service.ts`    | `cancelSession(id)`                        | `sessions/[id]/cancel/route.ts`      |
| `session-service.ts`    | `interruptSession(id)`                     | `sessions/[id]/interrupt/route.ts`   |
| `session-service.ts`    | `setSessionPermissionMode(id, mode)`       | `sessions/[id]/mode/route.ts`        |
| `session-service.ts`    | `setSessionModel(id, model)`               | `sessions/[id]/model/route.ts`       |
| `session-service.ts`    | `getSessionLogInfo(id)`                    | `sessions/[id]/logs/stream/route.ts` |
| `session-service.ts`    | `getSessionStatus(id)`                     | `sessions/[id]/logs/stream/route.ts` |
| `session-service.ts`    | `handleControlMessage(id, control)`        | `sessions/[id]/control/route.ts`     |
| `session-service.ts`    | `sendMessageToSession(id, msg, img?)`      | `sessions/[id]/message/route.ts`     |
| `session-service.ts`    | `resumeWithNewMode(id, mode, prompt, ref)` | `sessions/[id]/control/route.ts`     |
| `capability-service.ts` | `assertPromptModeCapability(capId)`        | `sessions/route.ts` POST             |
| `capability-service.ts` | `findPromptCapability(agentId)`            | `projects/[id]/sessions/route.ts`    |
| `dashboard-service.ts`  | `getQuickStats()`                          | `stats/route.ts`                     |
| `cli-import.ts`         | `importCliSession(params)`                 | `sessions/import/route.ts`           |

---

#### Intentionally Skipped Routes (no dynamic UUID params or already clean)

| Route                              | Reason                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `sessions/[id]/memory/route.ts`    | Delegates to `buildMemoryHandlers` + `getSession()` -- already service-based |
| `dashboard/route.ts`               | No params, delegates to `getDashboardStats()`                                |
| `search/route.ts`                  | No params, delegates to service search functions                             |
| `projects/route.ts`                | Collection route, delegates to `listProjects`/`createProject`                |
| `projects/discover/route.ts`       | No dynamic params                                                            |
| `projects/check-path/route.ts`     | No dynamic params                                                            |
| `agents/route.ts`                  | Collection route, delegates to service functions                             |
| `agents/discover/route.ts`         | No dynamic params                                                            |
| `tasks/route.ts`                   | Collection route, delegates to `listTasksByStatus`/`createTask`              |
| `plans/route.ts`                   | Collection route, delegates to service                                       |
| `plans/mcp-save/route.ts`          | No dynamic params, delegates to `savePlanFromMcp`                            |
| `snapshots/route.ts`               | Collection route, delegates to service                                       |
| `workspaces/route.ts`              | Collection route, delegates to service                                       |
| `workers/status/route.ts`          | No dynamic params                                                            |
| `models/route.ts`                  | No dynamic params                                                            |
| `cli-sessions/route.ts`            | No dynamic params, delegates to service                                      |
| `mcp/config/route.ts`              | No dynamic params                                                            |
| `notifications/subscribe/route.ts` | No dynamic params                                                            |
| `usage/claude/route.ts`            | No dynamic params                                                            |
| `config/*/route.ts`                | Config routes, no dynamic UUID params                                        |
| `terminal/token/route.ts`          | No dynamic params                                                            |
| `sse/board/route.ts`               | SSE streaming, uses `listTasksBoardItems` service                            |
| `system-stats/route.ts`            | Proxies to external monitor API, no DB                                       |
| `discovery/scan/route.ts`          | No dynamic params                                                            |
| `discovery/confirm/route.ts`       | No dynamic params                                                            |
| `gemini/prompt/route.ts`           | No dynamic params                                                            |

---

#### Summary

- **Total route files audited**: 65
- **Routes with dynamic UUID params**: 39 handler functions (across 24 files)
- **Routes missing `assertUUID`**: 22 handler functions (across 12 files)
- **Routes with direct DB calls**: 14 instances (across 10 files)
- **New service functions needed**: 15
- **Business logic blocks to extract**: 6

---

#### Risk Assessment

**High risk (test carefully):**

- `sessions/[id]/control/route.ts` -- Most complex route. Handles ExitPlanMode restart, idle resume, clearContextRestart. Extracting to service must preserve the exact PG NOTIFY + enqueue sequencing. Regression risk if any branch is missed.
- `sessions/[id]/cancel/route.ts` -- The atomic `UPDATE ... WHERE status IN (...)` + PG NOTIFY must remain transactional. Moving to service should keep the same atomicity guarantees.
- `sessions/[id]/message/route.ts` -- Cold resume vs hot path branching with image attachment handling. File I/O (mkdirSync, writeFileSync) interleaved with DB/queue operations.
- `sessions/import/route.ts` -- Multi-step import with 5 separate DB queries. Partial failure could leave orphaned session rows. Consider wrapping in a transaction when moving to service.

**Medium risk:**

- `sessions/[id]/mode/route.ts` and `sessions/[id]/model/route.ts` -- Straightforward DB update + conditional PG NOTIFY. Low complexity but the conditional publish logic must be preserved.
- `sessions/[id]/events/route.ts` GET -- SSE endpoint with PG NOTIFY subscription. The inline DB query is simple but the function is NOT wrapped in `withErrorBoundary` (uses raw `export async function GET`). Adding assertUUID here requires care since NotFoundError won't be caught by the standard error handler.

**Low risk:**

- Adding `assertUUID` to agent routes, task sub-routes (subtasks, reorder, dependencies, events) -- these already delegate to services that will throw NotFoundError for invalid UUIDs, but assertUUID provides earlier/cleaner failure.
- `stats/route.ts` -- Simple count queries, easy to move to dashboard-service.
- `sessions/[id]/logs/stream/route.ts` -- Inline query functions are simple selects, easy to extract.

**Special note -- non-`withErrorBoundary` routes:**
Two routes with dynamic params use raw `export async function GET` instead of `withErrorBoundary`:

- `sessions/[id]/events/route.ts` GET (line 25)
- `sessions/[id]/logs/stream/route.ts` GET (line 9)

Both are SSE streaming endpoints. `assertUUID` throws `NotFoundError`, which is an `AppError` subclass. Without `withErrorBoundary`, these errors would become unhandled 500s. Fix options: (a) wrap the handler body in `withErrorBoundary` (returning the SSE Response from within), or (b) add a manual try-catch around `assertUUID` before the streaming begins.
