# Codebase Deduplication Audit Report

**Date:** 2026-03-19
**Method:** 5 parallel research agents auditing tool descriptions, event handling, SSE/streaming, preamble building, and service layer patterns.

## Top 10 Deduplication Opportunities (Ranked by Impact)

### #1 — DeltaBuffer Class (HIGH IMPACT)

**~90 lines across 4 files, identical pattern**

The same delta-buffer-with-periodic-flush pattern appears in:

- `src/lib/worker/brainstorm-orchestrator.ts` (participant.deltaBuffer + deltaFlushTimer)
- `src/lib/worker/activity-tracker.ts` (deltaBuffer + deltaFlushTimer, lines 210-245)
- `src/lib/worker/session-process.ts` (deltaBuffer + deltaFlushTimer, lines 177-216)
- `src/stores/brainstorm-store.ts` (streamingText Map, lines 255-261)

**Fix:** Extract `src/lib/utils/delta-buffer.ts` — a reusable `DeltaBuffer` class with `append()`, `flush()`, `clear()` methods and configurable flush interval.

---

### #2 — SSE Listener Registry (HIGH IMPACT)

**~40 lines exact duplication in 1 file**

`src/lib/worker/worker-sse.ts` has two identical functions:

- `addSessionEventListener()` (lines 60-79)
- `addBrainstormEventListener()` (lines 85-104)

Both: get Set from Map by ID → create Set if missing → add callback → return unsubscribe function.

**Fix:** Extract `createEventListenerRegistry<T>()` factory function returning `{ add, listeners }`.

---

### #3 — Generic Log File Event Reader (HIGH IMPACT)

**~64 lines of near-identical control flow**

`src/lib/realtime/event-utils.ts`:

- `readEventsFromLog()` (lines 43-71) — session events
- `readBrainstormEventsFromLog()` (lines 82-116) — brainstorm events

Same flow: split lines → strip prefixes → parse structured format → detect ID resets → filter by threshold. Only the parser differs.

**Fix:** Extract generic `readEventsFromLog<T>(logContent, afterSeq, parser)` with specific wrappers.

---

### #4 — shortPath() Unification (MEDIUM-HIGH IMPACT)

**3 different implementations across 3 files**

- `src/lib/utils/tool-descriptions.ts:11-14` — segment-based slicing (canonical)
- `src/components/config/config-editor-textarea.tsx:28-32` — home path abbreviation (`~`)
- `src/components/settings/token-usage-tab.tsx:155` — inline home path replacement

**Fix:** Add `shortPathHome()` variant to `tool-descriptions.ts` that does `~` substitution. Import everywhere.

---

### #5 — safeUnlink Utility (MEDIUM IMPACT)

**27 occurrences of `await import('node:fs/promises')` for file deletion**

Dynamic import of `node:fs/promises` + `.catch(() => {})` pattern repeated across session-service, plan-service, and others.

**Fix:** Extract `src/lib/utils/fs-utils.ts` with `safeUnlink(path)` and `safeUnlinkMany(paths[])`.

---

### #6 — Worker HTTP Dispatcher Factory (MEDIUM IMPACT)

**~34 lines across 4 near-identical route handlers**

`src/lib/worker/worker-http.ts`: Session and brainstorm control/event handlers (lines 126-233) follow identical read-body → validate → lookup-handler → dispatch-or-404 pattern.

**Fix:** Extract `createDispatcher(handlerMap, invokeFn)` factory.

---

### #7 — appendWithWindow Utility (LOW-MEDIUM IMPACT)

**~13 lines across 2 hooks**

- `src/hooks/use-session-stream.ts` (MAX_EVENTS = 2000)
- `src/hooks/use-session-log-stream.ts` (MAX_LINES = 5000)

**Fix:** Extract `appendWithWindow<T>(existing, incoming, maxSize)` utility.

---

### #8 — truncateToWords Extraction (LOW IMPACT)

**Private static method in brainstorm-orchestrator**

`BrainstormOrchestrator.truncateToWords()` is a general utility trapped as a private static method.

**Fix:** Move to `src/lib/utils/text-utils.ts`.

---

### #9 — MCP Prefix Stripping (LOW IMPACT)

**2 slightly different regexes in same file**

`src/lib/utils/tool-descriptions.ts` lines 54 and 86 both strip `mcp__` prefixes with different regex patterns.

**Fix:** Extract `getMcpToolShortName(toolName)` helper, use in both places.

---

### #10 — SSE Handler Boilerplate (MEDIUM but RISKY)

**~30-40 lines of shared setup in worker-sse.ts**

`handleSessionSSE()` and `handleBrainstormSSE()` share setup, listener registration, buffering, and cleanup patterns. But catchup logic differs significantly.

**Fix:** Could extract common setup/teardown into a shared helper, but the domain-specific catchup logic makes full abstraction risky. Recommend extracting only the SSE setup/cleanup boilerplate.

---

## Items Considered but NOT Recommended

| Pattern                                     | Why Not                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| API Route Factory (30+ routes)              | Makes routes harder to customize; Next.js convention is explicit route files |
| Base CRUD Service (9+ services)             | Drizzle queries are already concise; generic base adds indirection           |
| Event Dispatcher Registry (5 switch blocks) | Switch/case is readable, fast, and easy to extend                            |
| Preamble Builder class                      | Session and brainstorm preambles are fundamentally different domains         |

These would reduce LOC but increase complexity and make the code harder to navigate. **DRY without over-abstracting.**

---

### BONUS #11 — ACP Event Mapper Duplication (HIGH IMPACT — found by team researchers)

**~190 lines, 95% exact match across 3 files**

`gemini-event-mapper.ts` (204 lines), `copilot-event-mapper.ts` (194 lines), `opencode-event-mapper.ts` (174 lines) define near-identical synthetic event type unions and mapper functions. Only the prefix differs (`gemini:*` → `copilot:*` → `opencode:*`).

**Fix:** Create parameterized `createAcpEventMapper(prefix)` factory. Agent-specific handlers override only the cases that differ.

---

### BONUS #12 — Plan Mode Preamble Text Duplication (MEDIUM IMPACT — found by team researchers)

**~60 lines of near-identical prompt text across 3 agent branches**

In `src/lib/worker/session-preambles.ts`, `generatePlanConversationPreamble()` has Codex/Gemini/Copilot/Opencode branches where 3 produce almost identical "review plan in read-only mode, save with save_plan tool" text.

**Fix:** Extract common read-only plan preamble into a template constant. Only Codex variant stays separate (uses `permissionMode='plan'`).

---

## Recommended Refactoring Scope

**Phase 1 (this session):** Items #1-#6 (~280 lines of duplication eliminated)
**Phase 2 (next session):** Items #7-#10, #11-#12 (~300+ lines, including ACP mapper consolidation)
**Deferred:** Items marked as over-abstraction risk (API route factory, base CRUD, event dispatcher registry)
