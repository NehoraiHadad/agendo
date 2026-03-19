# Codebase Deduplication Audit — 2026-03-19

## Top 10 Deduplication Opportunities (Ranked by Impact)

### 1. 🏆 `useAsyncAction()` hook — ~400+ lines across 24+ files

**Pattern:** `const [isPending, setIsPending] = useState(false); const [error, setError] = useState<string|null>(null)` + try/catch/finally wrapper repeated in every dialog and action component.
**Fix:** Extract `useAsyncAction()` hook returning `{ execute, isPending, error, clearError }`.
**Difficulty:** Easy | **Files:** 24+ components

### 2. 🏆 `getErrorMessage()` utility — ~30+ occurrences across 20+ files

**Pattern:** `err instanceof Error ? err.message : String(err)` repeated everywhere.
**Fix:** Extract to `src/lib/utils/error-utils.ts`.
**Difficulty:** Easy | **Files:** 20+ (services, actions, worker)

### 3. 🏆 `useFetch<T>()` hook — ~200 lines across 13 files

**Pattern:** `useEffect` + `new AbortController()` + `fetch(url, { signal })` + cleanup in 13 components.
**Fix:** Extract `useFetch<T>(url, deps)` hook with abort, loading, error states.
**Difficulty:** Easy | **Files:** 13 components

### 4. 🥈 Stream reducer factory — ~150 lines across 3 hooks

**Pattern:** Nearly identical `useReducer` with `SET_STATUS`, `SET_CONNECTED`, `SET_ERROR`, `RESET` actions across `use-session-stream.ts`, `use-session-log-stream.ts`, `use-multi-session-streams.ts`.
**Fix:** Extract `createStreamReducer<State>()` factory.
**Difficulty:** Easy | **Files:** 3 hooks

### 5. 🥈 `use-board-sse.ts` reimplements `use-event-source.ts` — ~80 lines

**Pattern:** Manual EventSource + exponential backoff reconnection duplicated when `useEventSource` hook already exists.
**Fix:** Rewrite `use-board-sse.ts` as thin wrapper around `useEventSource()`.
**Difficulty:** Easy | **Files:** 1 hook

### 6. 🥈 Service `getById + requireFound` pattern — ~40 lines across 5+ services

**Pattern:** `const [row] = await db.select().from(table).where(eq(table.id, id)).limit(1); return requireFound(row, 'Entity', id);` repeated in every service.
**Fix:** Extract `getById<T>(table, id, entityName)` generic helper.
**Difficulty:** Easy | **Files:** 5+ services

### 7. 🥉 Status badge config objects — ~200 lines across 5+ files

**Pattern:** `Record<Status, { label, dotColor, pillBg, pillBorder, textColor, pulse }>` pattern repeated per entity type.
**Fix:** Create `createStatusConfig()` factory or generic `<StatusBadge>` component.
**Difficulty:** Easy | **Files:** 5+ components

### 8. 🥉 `formatRelativeTime()` + time constants — ~30 lines across 4+ files

**Pattern:** Identical `formatRelativeTime()` function in `team-message-card.tsx` and `team-panel.tsx`, plus scattered `3_600_000` / `86_400_000` magic numbers.
**Fix:** Extract to `src/lib/utils/format-time.ts` with `TIME_CONSTANTS`.
**Difficulty:** Easy | **Files:** 4+ components

### 9. 🥉 Task status transition + event emission — ~30 lines within task-service.ts

**Pattern:** `if (input.status && input.status !== existing.status) { taskMachine.assert(); ... db.insert(taskEvents)... }` duplicated between `updateTask()` and `reorderTask()`.
**Fix:** Extract `validateAndEmitStatusChange()` helper.
**Difficulty:** Easy | **Files:** 1 service (internal)

### 10. 🥉 `AgentAvatar` component — ~120 lines across 3+ files

**Pattern:** Repeated `getAgentColor() + getInitials() + styled div` JSX in brainstorm message-card, participant-sidebar, create-dialog.
**Fix:** Extract `<AgentAvatar>` component.
**Difficulty:** Easy | **Files:** 3+ components

---

## Honorable Mentions (Deferred)

- ReadableStream SSE factory across 5 API routes (~150 lines, medium effort)
- Event type switch statements across session-chat-utils + context-extractor (~300 lines, medium effort)
- Dialog/form layout patterns (~400 lines, medium effort — high risk of over-abstraction)
- ACP event type unions (~180 lines, hard — TypeScript limitation)
- Search pattern (ILIKE) across 3 services (~60 lines, medium)
- Date formatting scattered across 14+ files (~80 lines, medium)

## Summary

- **Total identified duplication:** ~2500+ lines
- **Top 10 refactors would eliminate:** ~1300+ lines
- **All top 10 are rated Easy difficulty**
- **No over-abstraction risk** — each is a clear, well-bounded utility/hook/component
