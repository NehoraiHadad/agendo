# Codebase Deduplication Audit Report

**Date:** 2026-03-19
**Method:** 4 parallel explorer agents scanning API routes, worker/adapters, components/hooks, and services/utils

---

## Top 10 Deduplication Opportunities (Ranked by Impact)

### #1 — Form Submission Hook (`useFormSubmit`)

- **Layer:** Components/Hooks
- **Lines saved:** ~400-500
- **Files affected:** 20+ form components
- **Pattern:** Every form manually implements `[isSubmitting, setIsSubmitting]` + `try/catch/finally` + error state + success callback
- **Fix:** Extract `useFormSubmit<T>()` hook that encapsulates loading, error, and submission lifecycle
- **Risk:** Low — pure extraction, no behavior change
- **Priority:** REFACTOR NOW

### #2 — ACP Client Handler Factory

- **Layer:** Worker/Adapters
- **Lines saved:** ~150-180
- **Files affected:** 3 (gemini-client-handler.ts, copilot-client-handler.ts, opencode-client-handler.ts)
- **Pattern:** Identical `requestPermission()`, `sessionUpdate()`, `readTextFile()`/`writeTextFile()` across all 3 ACP client handlers. Only difference is event type prefix.
- **Fix:** Extract `BaseAcpClientHandler` class or `createAcpClientHandler()` factory with config-driven prefix
- **Risk:** Medium — touches critical adapter layer, needs careful testing
- **Priority:** REFACTOR NOW

### #3 — SSE Stream Hook Consolidation (`useGenericEventSource`)

- **Layer:** Hooks
- **Lines saved:** ~200-300
- **Files affected:** 5 hooks (use-session-stream, use-session-log-stream, use-brainstorm-stream, use-multi-session-streams, use-board-sse)
- **Pattern:** All 5 hooks follow identical: init state → useEventSource() → dispatch SET_CONNECTED/ERROR/RESET → handle events → track lastEventId
- **Fix:** Extract `useGenericEventSource<T>()` that takes URL + event handlers + done condition
- **Risk:** Medium — SSE reconnection is sensitive, needs integration testing
- **Priority:** PLAN FOR NEXT

### #4 — CRUD Route Handler Factory

- **Layer:** API Routes
- **Lines saved:** ~150+
- **Files affected:** 20+ route files
- **Pattern:** Every `[id]/route.ts` repeats: `const { id } = await params` → `assertUUID()` → service call → `Response.json({ data })`. GET/PATCH/DELETE all follow templates.
- **Fix:** `createGetRoute()`, `createPatchRoute()`, `createDeleteRoute()` factories in `src/lib/api-routes.ts`
- **Risk:** Low — mechanical extraction
- **Priority:** REFACTOR NOW

### #5 — Inline Fetch in useEffect (`useLoadOnOpen`)

- **Layer:** Components
- **Lines saved:** ~200+
- **Files affected:** 15+ dialog/panel components
- **Pattern:** `useEffect(() => { if (!open) return; setLoading(true); apiFetch().then().catch().finally(); }, [open])` repeated everywhere
- **Fix:** `useLoadOnOpen<T>(url, deps)` returning `{ data, isLoading, error }`
- **Risk:** Low
- **Priority:** REFACTOR NOW

### #6 — Error Display Component (`<ErrorAlert>`)

- **Layer:** UI Components
- **Lines saved:** ~150
- **Files affected:** 24 components
- **Pattern:** 3 different variants of `{error && <p className="text-xs text-red-400 ...">}` scattered across codebase
- **Fix:** Single `<ErrorAlert message={error} />` component with consistent styling
- **Risk:** Very low
- **Priority:** REFACTOR NOW

### #7 — Server Action Error Handling Wrapper

- **Layer:** Actions
- **Lines saved:** ~60+
- **Files affected:** 3 action files, 12 functions
- **Pattern:** Every server action wraps: `try { validate → call service → revalidate → return success } catch { return error }`
- **Fix:** `withActionHandler()` wrapper that auto-catches Zod errors and returns `ActionResult<T>`
- **Risk:** Low
- **Priority:** REFACTOR NOW

### #8 — Query Parameter Parsing Utility

- **Layer:** API Routes
- **Lines saved:** ~70
- **Files affected:** 15+ routes
- **Pattern:** Manual `url.searchParams.get()` + parseInt + boolean parsing repeated in every list route
- **Fix:** `QueryParams` helper class with typed `getString()`, `getNumber()`, `getBoolean()` methods
- **Risk:** Very low
- **Priority:** REFACTOR NOW

### #9 — ACP Interrupt Escalation Logic

- **Layer:** Worker/Adapters
- **Lines saved:** ~50-60
- **Files affected:** 2-3 (gemini-adapter.ts, copilot-adapter.ts, opencode-adapter.ts)
- **Pattern:** Identical 4-step SIGINT→SIGTERM→SIGKILL escalation with timers
- **Fix:** `performAcpInterrupt()` utility with optional ACP cancel step
- **Risk:** Low
- **Priority:** PLAN FOR NEXT

### #10 — Inconsistent DELETE Response Format

- **Layer:** API Routes
- **Lines saved:** ~15 (but prevents API contract bugs)
- **Files affected:** 15 DELETE handlers
- **Pattern:** 4 different response formats: `{ success: true }`, `{ data: { id } }`, `{ data: null }`, `204 No Content`
- **Fix:** Standardize all to `204 No Content` via `deleteResponse()` helper
- **Risk:** Low (but clients may depend on current format — check frontend)
- **Priority:** REFACTOR NOW

---

## Honorable Mentions (Outside Top 10)

| Opportunity                       | Lines  | Files | Reason Not Top 10                                              |
| --------------------------------- | ------ | ----- | -------------------------------------------------------------- |
| Native Session Readers base class | ~600   | 3     | High savings but complex abstraction, risk of over-engineering |
| MCP Tool Registration boilerplate | ~200   | 8     | Verbose but each tool is unique enough                         |
| Dialog/Draft state hook           | ~100   | 9     | Medium savings, draft logic varies per dialog                  |
| Loading Spinner component         | ~100   | 35+   | Trivial extraction, low complexity                             |
| Custom Command/Skill loading      | ~60-80 | 3     | Different file formats make abstraction awkward                |
| Status config objects             | ~50    | 2     | Low savings                                                    |

---

## Implementation Plan

**Phase 1 — Quick Wins (this session):** #4, #6, #7, #8, #10
**Phase 2 — Medium Effort (this session if time):** #1, #5
**Phase 3 — Needs Integration Testing:** #2, #3, #9

**Estimated total savings:** ~1,400-1,600 lines of code
