# Codebase Deduplication Audit — Top 10 Opportunities

Ranked by impact (lines saved × number of files affected × risk-adjusted feasibility).

---

## #1 — Client-Side SSE Hook Consolidation (~250 lines saved)

**Impact: HIGH | Risk: MEDIUM | Files: 5**

5 hooks repeat identical EventSource connection, exponential backoff, and reconnection logic:

- `src/hooks/use-session-stream.ts` (198 lines)
- `src/hooks/use-session-log-stream.ts` (173 lines)
- `src/hooks/use-multi-session-streams.ts` (248 lines)
- `src/hooks/use-brainstorm-stream.ts` (97 lines)
- `src/hooks/use-board-sse.ts`

**Shared patterns:**

- `retryDelayRef` + exponential backoff (identical in all 5)
- `lastEventIdRef` + URL building with catchup
- `EventSource` creation + `onopen`/`onmessage`/`onerror` handlers
- JSON parsing with try/catch
- `isDoneRef` pattern to stop reconnecting
- Event buffer with max-size trimming (MAX_EVENTS/MAX_LINES)

**Refactoring:** Create `src/hooks/use-event-source.ts` — a generic SSE hook factory:

```typescript
function useEventSource<T>(config: {
  url: string | (() => string);
  maxEvents?: number;
  onEvent: (event: T) => void;
  shouldReconnect?: (event: T) => boolean;
  enabled?: boolean;
}) => { isConnected: boolean; error: string | null; reset: () => void }
```

---

## #2 — SSE Streaming Proxy Deduplication (~70 lines saved)

**Impact: HIGH | Risk: LOW | Files: 2**

Session and brainstorm SSE proxy routes are ~95% identical:

- `src/app/api/sessions/[id]/events/route.ts`
- `src/app/api/brainstorms/[id]/events/route.ts`

Both proxy to worker HTTP port 4102, add SSE headers, pipe through ReadableStream.

**Refactoring:** Create `src/lib/api/create-sse-proxy.ts`:

```typescript
export function createSSEProxy(workerPath: (id: string) => string) {
  return withErrorBoundary(async (req, { params }) => {
    const { id } = await params;
    // ... shared proxy logic
  });
}
```

---

## #3 — SSE Server-Side Headers & Encoding (~60 lines saved)

**Impact: MEDIUM | Risk: LOW | Files: 6+**

6+ routes repeat identical SSE headers and TextEncoder patterns:

```typescript
const headers = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};
const encoder = new TextEncoder();
controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
```

**Refactoring:** Create `src/lib/sse/constants.ts` + `src/lib/sse/encoder.ts`:

```typescript
export const SSE_HEADERS = { ... };
export function encodeSSE(data: unknown, id?: number): Uint8Array;
export function encodeHeartbeat(): Uint8Array;
```

---

## #4 — Reducer Action Types & Stream State (~100 lines saved)

**Impact: MEDIUM | Risk: MEDIUM | Files: 3**

Three stream hooks define nearly identical action types and state shapes:

- `use-session-stream.ts`: `APPEND_EVENT | SET_STATUS | SET_CONNECTED | SET_ERROR | RESET`
- `use-session-log-stream.ts`: `APPEND_LINES | SET_STATUS | SET_CONNECTED | SET_ERROR | RESET`
- `use-multi-session-streams.ts`: `APPEND_EVENT | SET_STATUS | SET_CONNECTED | SET_ERROR | REMOVE_SESSION`

**Refactoring:** Extract shared `StreamState` type and base reducer in `use-event-source.ts` (combines with #1).

---

## #5 — Tool Name Matching & Formatting (~50 lines saved)

**Impact: MEDIUM | Risk: LOW | Files: 3**

Tool name switch/if chains duplicated across:

- `src/lib/utils/tool-descriptions.ts` — canonical `describeToolActivity()`
- `src/lib/services/context-extractor.ts` — `summarizeToolCall()` (lines 371-399) + `renderTurnVerbatim()` (lines 437-445)
- `src/hooks/use-team-state.ts` — path shortening (line 172-175)

**Shared patterns:**

- Tool name matching (`Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`)
- Input field extraction (`file_path`, `path`, `pattern`, `command`)
- MCP prefix stripping (`/^mcp__\w+__/` vs `/^mcp__[^_]+__/`)
- Path shortening (`.slice(-2).join('/')` vs `.pop()`)

**Refactoring:** Have `context-extractor.ts` import from `tool-descriptions.ts`:

- Add `summarizeToolCall()` to `tool-descriptions.ts` (or have context-extractor call `describeToolActivity`)
- Standardize MCP regex
- Export `shortPath()` utility

---

## #6 — Service Get-By-ID Pattern (~40 lines saved)

**Impact: MEDIUM | Risk: LOW | Files: 7+**

7+ services have identical get-by-id:

```typescript
export async function getXById(id: string): Promise<X> {
  const [item] = await db.select().from(table).where(eq(table.id, id)).limit(1);
  return requireFound(item, 'X', id);
}
```

Some use `requireFound()`, others throw manually (inconsistent).

**Refactoring:** Standardize on `requireFound()` everywhere. A generic helper is possible but may over-abstract:

```typescript
export async function findById<T>(table: PgTable, id: string, label: string): Promise<T>;
```

**Decision:** Just standardize on `requireFound()` — a generic function adds complexity without much gain given each service's unique joins.

---

## #7 — Filter Building in List Operations (~60 lines saved)

**Impact: MEDIUM | Risk: MEDIUM | Files: 6+**

6+ services build filter arrays identically:

```typescript
const conditions = [];
if (filters?.status) conditions.push(eq(table.status, filters.status));
if (filters?.projectId) conditions.push(eq(table.projectId, filters.projectId));
const where = conditions.length > 0 ? and(...conditions) : undefined;
```

**Refactoring:** Create `src/lib/db/filter-builder.ts`:

```typescript
export function buildWhereClause(
  filters: Record<string, unknown>,
  columnMap: Record<string, Column>,
) {
  const conditions = Object.entries(filters)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => eq(columnMap[k], v));
  return conditions.length > 0 ? and(...conditions) : undefined;
}
```

---

## #8 — ToolOutput Styling Switch (minor, ~15 lines)

**Impact: LOW | Risk: LOW | Files: 1**

`session-chat-view.tsx` has a tool-name switch for styling classes. Not really a duplication issue — it's styling, not logic. Leave as-is unless tool-descriptions.ts grows a "tool category" concept.

**Decision:** Skip — not worth abstracting.

---

## #9 — Preamble Building (~minimal duplication)

**Impact: LOW | Risk: N/A | Files: 3**

Session preambles are already well-factored into `session-preambles.ts`. Brainstorm preambles are fundamentally different (multi-agent, roles, waves). No real duplication — different concerns, different templates.

**Decision:** No action needed. Already DRY.

---

## #10 — Status Transition Validation (~30 lines saved)

**Impact: LOW-MEDIUM | Risk: MEDIUM | Files: 3-4**

Task status validation (`isValidTaskTransition`) is duplicated in `updateTask()` and `reorderTask()`. Session and brainstorm services have their own ad-hoc status checks.

**Refactoring:** Extract status machine pattern:

```typescript
export function createStatusMachine<S extends string>(transitions: Record<S, S[]>) {
  return {
    isValid: (from: S, to: S) => transitions[from]?.includes(to) ?? false,
    assert: (from: S, to: S, label: string) => {
      if (!transitions[from]?.includes(to))
        throw new ConflictError(`Invalid ${label} transition: ${from} → ${to}`);
    },
  };
}
```

---

## Summary

| Rank | Opportunity                   | Lines Saved | Risk   | Action                    |
| ---- | ----------------------------- | ----------- | ------ | ------------------------- |
| #1   | Client SSE hook consolidation | ~250        | Medium | **REFACTOR**              |
| #2   | SSE streaming proxy           | ~70         | Low    | **REFACTOR**              |
| #3   | SSE headers & encoding        | ~60         | Low    | **REFACTOR**              |
| #4   | Reducer/stream state types    | ~100        | Medium | **REFACTOR** (part of #1) |
| #5   | Tool name formatting          | ~50         | Low    | **REFACTOR**              |
| #6   | Service get-by-id             | ~40         | Low    | **STANDARDIZE**           |
| #7   | Filter building               | ~60         | Medium | **REFACTOR**              |
| #8   | ToolOutput styling            | ~15         | Low    | **SKIP**                  |
| #9   | Preamble building             | ~0          | N/A    | **SKIP** (already DRY)    |
| #10  | Status transitions            | ~30         | Medium | **DEFER**                 |

**Total actionable savings: ~530+ lines** across items #1-7.
**Recommended for immediate refactoring: #1+#4 (combined), #2, #3, #5, #6, #7**
