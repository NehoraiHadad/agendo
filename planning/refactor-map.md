# Backend Refactor Map

**Generated**: 2026-03-01
**Analyst**: Phase 1 (read-only pass — no code changed)
**Scope**: `src/lib/worker/`, `src/lib/services/`, `src/app/api/`, `src/lib/actions/`

---

## 1. Files >200 Lines (sorted by size)

| File                                            | Lines | Notes                                |
| ----------------------------------------------- | ----- | ------------------------------------ |
| `src/lib/worker/session-process.ts`             | 992   | Core lifecycle orchestrator          |
| `src/lib/worker/adapters/gemini-adapter.ts`     | 665   | ACP protocol + model switching       |
| `src/lib/worker/adapters/claude-adapter.ts`     | 476   | NDJSON protocol + tool approval      |
| `src/lib/services/task-service.ts`              | 424   | Contains raw SQL                     |
| `src/lib/services/model-service.ts`             | 405   | Binary introspection for 3 providers |
| `src/lib/worker/execution-runner.ts`            | 380   | All-in-one execution runner          |
| `src/lib/worker/approval-handler.ts`            | 350   | Tool approval + AskUserQuestion      |
| `src/lib/worker/adapters/codex-event-mapper.ts` | 321   | Pure mapper — good size              |
| `src/lib/worker/activity-tracker.ts`            | 318   | Timers, heartbeat, delta buffers     |
| `src/lib/worker/session-runner.ts`              | 295   | Session bootstrap                    |
| `src/lib/services/agent-service.ts`             | 279   | Agent CRUD + discovery               |
| `src/lib/worker/adapters/codex-adapter.ts`      | 273   | New-process-per-turn pattern         |
| `src/lib/services/plan-service.ts`              | 259   | Mixes DB ops + large inline prompts  |
| `src/lib/worker/claude-event-mapper.ts`         | 257   | **MISPLACED** — not in adapters/     |
| `src/lib/actions/capability-actions.ts`         | 232   | Mixes CRUD + AI analysis             |
| `src/lib/services/ai-query-service.ts`          | 229   | Multi-provider AI query              |
| `src/lib/services/session-service.ts`           | 213   | Has 3 dead exports                   |
| `src/lib/services/config-service.ts`            | 208   | File tree/read/write                 |
| `src/lib/services/execution-service.ts`         | 200   | Clean CRUD                           |

---

## 2. Dead Code

### 2.1 Unexported / Never-called Symbols

| Location                  | Symbol                           | Evidence                                                                                      |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `session-service.ts:187`  | `claimSession()`                 | Exported but zero import sites                                                                |
| `session-service.ts:200`  | `getActiveSession()`             | Exported but zero import sites                                                                |
| `session-service.ts:59`   | `updateSession()`                | Exported but zero import sites                                                                |
| `approval-handler.ts:283` | `handleAskUserQuestion()`        | Defined but never called; session-process.ts comment says "// handleAskUserQuestion (unused)" |
| `activity-tracker.ts:281` | `ActivityTracker.scheduleKill()` | Static method with no callers outside the class file                                          |

### 2.2 Unreachable Code Branches

**`execution-runner.ts` — prompt-mode path (lines 113–132, 175–180)**

The API route (`/api/executions/route.ts:44`) explicitly blocks prompt-mode capabilities with `BadRequestError`. The `createExecution()` service is only called from that route. Therefore the `if (execution.mode === 'prompt')` branches in execution-runner are unreachable in production.

Affected lines:

- Lines 113–132: prompt resolution / promptOverride / interpolation
- Lines 175–180: `adapter.resume()` for prompt+sessionRef

The DB schema fields `prompt_override`, `parent_execution_id`, and `session_ref` on the `executions` table are artifacts of the pre-session-split architecture. They may hold old data but no new executions will populate them.

**`execution-runner.ts` — `buildCliFlagsArgv` / `interpolatePrompt` (private helpers)**

These are only called within execution-runner.ts and only for the `template` path. Fine to keep, but `interpolatePrompt` is dead for the `prompt` mode path above.

---

## 3. Duplication

### 3.1 `interpolatePrompt` — identical in two files

```
session-runner.ts:34      — function interpolatePrompt(template, args)
execution-runner.ts:362   — function interpolatePrompt(template, args)
```

Exact same implementation (regex `\{\{([\w.]+)\}\}`, dotted-path traversal). Should live in a shared `worker-utils.ts`.

### 3.2 `SIGKILL_DELAY_MS = 5_000` — defined in 4 places

| File                             | Type              |
| -------------------------------- | ----------------- |
| `session-control-handlers.ts:18` | `export const`    |
| `execution-runner.ts:21`         | private `const`   |
| `activity-tracker.ts:6`          | private `const`   |
| `base-adapter.ts:60`             | `static readonly` |

`session-process.ts` already imports it from `session-control-handlers.ts`. The other three should import from there instead of redeclaring it.

### 3.3 Working directory resolution — identical 3-liner

```typescript
// session-runner.ts:84–87
const taskWorkingDir = (task?.inputContext as { workingDir?: string } | null)?.workingDir;
const rawCwd = taskWorkingDir ?? project?.rootPath ?? agent.workingDir ?? '/tmp';
const resolvedCwd = await validateWorkingDir(rawCwd);
```

Byte-for-byte identical in `execution-runner.ts:85–87`. Should be a shared `resolveWorkingDir(task, project, agent)` helper in `worker-utils.ts`.

### 3.4 Env override collection — identical 7-liner

```typescript
// session-runner.ts:92–103  AND  execution-runner.ts:96–106
if (project?.envOverrides) {
  for (const [k, v] of Object.entries(project.envOverrides)) envOverrides[k] = v;
}
const taskEnv = (task?.inputContext as { envOverrides?: ... } | null)?.envOverrides;
if (taskEnv) {
  for (const [k, v] of Object.entries(taskEnv)) envOverrides[k] = v;
}
```

Should be extracted as `buildEnvOverrides(project, taskInputContext)` in `worker-utils.ts`.

### 3.5 CLAUDECODE env stripping — two different approaches

- `execution-runner.ts:107–108`: `delete childEnv['CLAUDECODE']; delete childEnv['CLAUDE_CODE_ENTRYPOINT']`
- `session-process.ts:265`: filter during copy `key !== 'CLAUDECODE' && key !== 'CLAUDE_CODE_ENTRYPOINT'`

These strip the same keys but via different mechanisms. The `buildChildEnv()` function in `safety.ts` could be enhanced to accept a `stripKeys` option and handle this centrally.

### 3.6 Memory API routes — near-identical route pairs

`src/app/api/sessions/[id]/memory/route.ts` (81 lines) and `src/app/api/executions/[id]/memory/route.ts` (81 lines) are structurally identical:

- Same `readFileOrEmpty` helper (copied verbatim)
- Same `GLOBAL_CLAUDE_MD` constant
- Same GET/POST logic (look up parent entity → look up agent → read/write CLAUDE.md files)
- Only difference: one calls `getSession(id)`, the other calls `getExecutionById(id)`

Should share a handler: `buildMemoryHandlers(getEntityFn)`.

### 3.7 Gemini `session/load` + fallback — duplicated in `initAndRun` and `setModel`

`gemini-adapter.ts` duplicates 22 lines of session/load logic with fallback to session/new:

- `initAndRun` (lines 520–550)
- `setModel` (lines 213–243)

Should be extracted as a private `loadOrCreateSession(opts, resumeSessionId)` method.

---

## 4. Misplaced Files

### 4.1 `worker/claude-event-mapper.ts` — wrong directory

All event mappers follow a consistent pattern in `worker/adapters/`:

- `worker/adapters/codex-event-mapper.ts`
- `worker/adapters/gemini-event-mapper.ts`

But `claude-event-mapper.ts` lives in `worker/` (root), not `worker/adapters/`. It has no dependency on worker infrastructure — it's a pure function that maps Claude NDJSON to `AgendoEventPayload[]`, exactly like the other two mappers.

**Proposed**: move to `worker/adapters/claude-event-mapper.ts` and update the single import in `session-process.ts`.

---

## 5. Unclear Responsibilities

### 5.1 `session-runner.ts` — does too much in one function

`runSession()` (295 lines, single function body) handles:

1. DB loading (session, agent, capability, task, project)
2. Working dir resolution
3. Env override collection
4. Prompt interpolation from capability template
5. Binary name detection (`binaryName = ...split('/').pop()`)
6. MCP config file generation (Claude path)
7. MCP server list generation (Gemini path)
8. Context preamble injection (for new sessions with MCP)
9. Resume context summary injection (for cold resumes)
10. Pending resume image loading
11. Adapter selection + SessionProcess instantiation + `start()`
12. Live process registration cleanup

Phases 6–9 are pure string/data transformations that could be extracted into a `buildSessionPrompt()` function or a `SessionBootstrapContext` builder.

### 5.2 `execution-runner.ts` — cost extraction from log file is an anti-pattern

Lines 263–297: after closing the log file, execution-runner re-opens and scans it line-by-line to extract cost/turns/duration from the Claude `result` event. This means:

- A 10MB log is read twice (once while streaming, once to scan for cost)
- The regex stripping of log prefixes (`^\[(stdout|stderr|system)\] `) is fragile

The cost data is already available in `session-process.ts` (which calls `onResultStats` directly from the event mapper). Execution-runner should capture cost during the streaming `onData` callback, not re-read the log file after close.

### 5.3 `task-service.ts` — raw SQL + push notification mixed with DB logic

- `listTasksBoardItems()` (lines 124–170): uses raw SQL template with manual column mapping. The surrounding Drizzle code uses proper ORM. The raw SQL exists to do a LEFT JOIN subquery for subtask counts — this could be expressed with Drizzle's `sql` subquery helper, but keeping it raw adds a maintenance burden (manual camelCase mapping).
- `updateTask()` (line 232): calls `sendPushToAll()` — mixing push notification side effects into the persistence layer. Notification dispatch should live at the service call site (API route or action) not inside the data access function.

### 5.4 `capability-actions.ts` — two unrelated concerns

Lines 1–127: thin wrappers delegating to `capability-service` functions (CRUD actions).
Lines 129–232: AI analysis logic (`buildAnalysisPrompt`, `extractJsonArray`, `analyzeCapabilitiesWithAI`).

The AI analysis portion has its own input/output types, an inline prompt builder, and JSON extraction logic. This belongs in a dedicated `capability-analysis-action.ts` or `src/lib/actions/analyze-actions.ts`.

### 5.5 `plan-service.ts` — inline large prompt strings mixed with DB operations

`executePlan()` (lines 112–169), `startPlanConversation()` (lines 176–216), and `validatePlan()` (lines 223–259) each embed multi-paragraph prompt strings inline in the business logic.

Additionally, `validatePlan()` at line 242 calls `execFileSync('git', ['rev-parse', 'HEAD'])` — the only place in the services layer that spawns a subprocess. This is unusual for a service and could cause timeouts or hangs in non-git contexts.

### 5.6 `approval-handler.ts` — direct mutation of shared `Session` object

`persistAllowedTool()` (lines 339–349) mutates `this.session.allowedTools` in-place (`this.session.allowedTools = updated`). The session object is owned by `session-process.ts` and shared via the constructor argument. Mutating it from inside approval-handler creates invisible coupling.

### 5.7 `activity-tracker.ts` — public methods that should be private

`stopHeartbeat()` (line 156) and `stopMcpHealthCheck()` (line 201) are `public` but have no callers outside the class — all callers go through `stopAllTimers()`. Making them private would shrink the class's public API.

---

## 6. Prioritized Hit List

### P0 — Dead Code Removal (safe, immediate wins, zero risk)

| #   | File                                  | Issue                                               | Fix                                                                                |
| --- | ------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D1  | `session-service.ts:187`              | `claimSession` — exported, no callers               | Delete the export                                                                  |
| D2  | `session-service.ts:200`              | `getActiveSession` — exported, no callers           | Delete the export                                                                  |
| D3  | `session-service.ts:59`               | `updateSession` — exported, no callers              | Delete the export                                                                  |
| D4  | `approval-handler.ts:283`             | `handleAskUserQuestion` — defined, never called     | Delete the method                                                                  |
| D5  | `activity-tracker.ts:281`             | `ActivityTracker.scheduleKill` — static, no callers | Delete the method                                                                  |
| D6  | `execution-runner.ts:113–132,175–180` | Prompt-mode branches — unreachable via API          | Remove branches; add `if (execution.mode === 'prompt') throw new Error(...)` guard |

### P1 — Deduplication (reduces maintenance surface, safe to extract)

| #   | Files                                                              | Issue                                | Fix                                                                            |
| --- | ------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| U1  | `session-runner.ts:34`, `execution-runner.ts:362`                  | `interpolatePrompt` duplicate        | Extract to `src/lib/worker/worker-utils.ts`                                    |
| U2  | 4 files with `SIGKILL_DELAY_MS`                                    | Constant redeclared                  | Import from `session-control-handlers.ts` (already exported)                   |
| U3  | `session-runner.ts:84–87`, `execution-runner.ts:85–87`             | `resolveWorkingDir` pattern          | Extract as `resolveWorkingDir(task, project, agent)` in `worker-utils.ts`      |
| U4  | `session-runner.ts:92–103`, `execution-runner.ts:96–106`           | Env override collection              | Extract as `buildEnvOverrides(project, taskInputContext)` in `worker-utils.ts` |
| U5  | `gemini-adapter.ts:213–243`, `gemini-adapter.ts:520–550`           | `session/load` + fallback duplicated | Extract private `loadOrCreateSession()` method                                 |
| U6  | `sessions/[id]/memory/route.ts`, `executions/[id]/memory/route.ts` | Near-identical routes                | Share a `buildMemoryHandlers(getEntityFn)` helper                              |

### P2 — Structural / Misplacement (simple renames/moves, safe)

| #   | File                            | Issue                                     | Fix                                                                                       |
| --- | ------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| M1  | `worker/claude-event-mapper.ts` | Lives in `worker/` not `worker/adapters/` | Move to `worker/adapters/claude-event-mapper.ts`; update 1 import in `session-process.ts` |
| M2  | `capability-actions.ts:129–232` | AI analysis mixed with CRUD actions       | Extract to `src/lib/actions/capability-analysis-action.ts`                                |

### P3 — Responsibility Separation (moderate effort, high value)

| #   | File                          | Issue                                          | Fix                                                                            |
| --- | ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| R1  | `session-runner.ts`           | Prompt construction in runSession              | Extract phases 6–9 into `buildSessionBootstrap(session, task, project, agent)` |
| R2  | `execution-runner.ts:263–297` | Cost re-scanned from log file post-close       | Capture cost during `onData` streaming; remove re-read                         |
| R3  | `task-service.ts:232`         | `sendPushToAll` side effect inside persistence | Move notification to API route/action layer                                    |
| R4  | `plan-service.ts:242`         | `execFileSync('git',...)` inside service       | Extract to helper or move to route handler                                     |
| R5  | `approval-handler.ts:339–349` | Direct mutation of `session.allowedTools`      | Return updated array; let session-process apply it                             |

### P4 — Visibility / Encapsulation (low risk, cosmetic)

| #   | File                          | Issue                                                                         | Fix                                                           |
| --- | ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| E1  | `activity-tracker.ts:156,201` | `stopHeartbeat`, `stopMcpHealthCheck` are public but have no external callers | Make private                                                  |
| E2  | `execution-runner.ts:107–108` | CLAUDECODE strip via `delete` while session-process uses filter               | Unify in `buildChildEnv(opts: { stripKeys? })` in `safety.ts` |

### P5 — Long-Term Technical Debt (high effort, low urgency)

| #   | File                      | Issue                                           | Note                                         |
| --- | ------------------------- | ----------------------------------------------- | -------------------------------------------- |
| T1  | `task-service.ts:124–170` | Raw SQL with manual camelCase mapping           | Drizzle subquery with `sql` template instead |
| T2  | `plan-service.ts`         | Large inline prompt strings mixed with DB logic | Extract to prompt template constants         |

---

## 7. Phase 2 Agent Assignments (recommended)

Based on the above, suggested work split for parallel agents:

**Phase 2A — Dead Code + Constants** (D1–D6, U2, E1)

- Files: `session-service.ts`, `approval-handler.ts`, `activity-tracker.ts`, `execution-runner.ts`, `session-control-handlers.ts`, `base-adapter.ts`
- Low risk, no new abstractions

**Phase 2B — Worker Utilities Extraction** (U1, U3, U4, M1, E2)

- Files: `session-runner.ts`, `execution-runner.ts`, `safety.ts`, `worker/claude-event-mapper.ts`
- Create: `src/lib/worker/worker-utils.ts`
- Move: `worker/claude-event-mapper.ts` → `worker/adapters/claude-event-mapper.ts`

**Phase 2C — Service Layer Cleanup** (U5, U6, R2, R3, M2)

- Files: `gemini-adapter.ts`, `sessions/[id]/memory/route.ts`, `executions/[id]/memory/route.ts`, `execution-runner.ts`, `task-service.ts`, `capability-actions.ts`
- Create: `src/lib/actions/capability-analysis-action.ts`
- Create: `src/app/api/_shared/memory-handler.ts` (or similar)

**Phase 3 (future)** — R1, R4, R5, T1, T2 — larger refactors requiring design decisions.

---

## 8. Cross-Cutting Notes for Phase 2 Agents

- **Do NOT rename DB columns** — `03-data-model.md` is the authority
- **Do NOT rename exported types** — check all consumers before renaming
- **TypeScript strict** — no `any` types in new code
- **Test coverage**: `src/lib/worker/__tests__/` has tests for safety.ts and execution-runner.ts — update if extracting functions they test
- **Import paths**: `@/` aliases work for Next.js app; worker build uses esbuild and supports them too
- The `claude-event-mapper.ts` move (M1) requires updating the import in `session-process.ts` line 42: `from '@/lib/worker/claude-event-mapper'` → `from '@/lib/worker/adapters/claude-event-mapper'`
