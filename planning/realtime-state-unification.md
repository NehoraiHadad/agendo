# ADR: Unify Session/Brainstorm Real-Time State Architecture

**Status**: Proposed
**Date**: 2026-03-22
**Author**: Claude Code (architecture analysis)

## Context

Sessions and brainstorms both consume real-time SSE event streams but use fundamentally different state management patterns:

| Dimension         | Sessions                                                | Brainstorms                                 |
| ----------------- | ------------------------------------------------------- | ------------------------------------------- |
| **State layer**   | `useReducer` + `createStreamReducer`                    | Zustand store (`brainstorm-store.ts`)       |
| **Deduplication** | O(n) `.some()` over event array                         | O(1) module-level `Set`                     |
| **Batching**      | None (dispatch per event)                               | RAF-coalesced `handleEventBatch()`          |
| **Window**        | 2000 events (sliding), 500 for multi-panel              | Unbounded (all messages kept)               |
| **Consumers**     | 3 components, single-consumer pattern                   | 5+ components, multi-consumer via selectors |
| **Event types**   | 40+ heterogeneous (text, tools, approvals, team, modes) | ~15 homogeneous (messages, status, waves)   |
| **Shared infra**  | `useEventSource` hook, `createStreamReducer` factory    | Same `useEventSource` hook                  |
| **Reconnect**     | Full state reset + `resetLastEventId()`                 | Server replays from log via `lastEventId`   |

Both share `useEventSource` (172 lines) for SSE connection management with exponential backoff.

## Analysis

### Question 1: Should sessions migrate to Zustand?

**Finding: Not today. The cost/benefit ratio is unfavorable.**

Sessions have 3 consumers of `useSessionStream`:

- `session-detail-client.tsx` (primary) — hosts the reducer, passes `stream.events` down
- `plan-conversation-panel.tsx` — independent stream for plan sessions
- `support-chat-popup.tsx` — independent stream for support chat

Each consumer creates its **own** stream for a **different** session ID. They don't share state — they're independent instances. This is the correct pattern for `useReducer`. Zustand would be needed if multiple components needed to subscribe to the **same** session's state at different points in the tree. That's not the case today.

The session detail page does have multiple derived hooks consuming the same `stream.events`:

- `useTeamState(stream.events)` — team panel
- `useGitContext(stream.events)` — git context
- `useFileContention(stream.events)` — contention warnings
- `buildDisplayItems(events)` — chat view

But these all receive events via props/args from the single `session-detail-client.tsx` parent. This is prop-threading (not prop-drilling) — efficient and explicit.

**When Zustand would become justified:**

- If session state needs to be consumed by components outside the session detail subtree (e.g., a global notification system, workspace-level session status indicators)
- If the session detail page is decomposed into separate routes/layouts that can't share a common parent
- If `use-multi-session-streams.ts` (workspace panel) needs to share state with individual session views

### Question 2: Should we extract a generic `createRealtimeStore()` factory?

**Finding: Not recommended. The domains are too different.**

A shared factory would need to abstract over:

```typescript
// Brainstorm: typed messages, participants, waves, streaming text
// Session: raw AgendoEvent array, status, permission mode

// These have fundamentally different shapes:
type BrainstormState = {
  messages: BrainstormMessageItem[]; // domain-typed
  participants: Map<string, Participant>; // indexed
  streamingText: Map<string, string>; // ephemeral
  currentWave: number; // domain-specific
};

type SessionState = {
  events: AgendoEvent[]; // raw event log
  sessionStatus: SessionStatus | null; // lifecycle
  permissionMode: string | null; // live config
};
```

The brainstorm store is a **domain model** — it transforms raw events into structured state (messages, participants, waves). The session stream is an **event log** — it keeps raw events and derives display items at render time via `buildDisplayItems()`.

A `createRealtimeStore()` factory would either:

1. Be so generic it provides no value beyond Zustand itself
2. Force both domains into a shared abstraction that fits neither well

**What IS worth extracting:** The specific performance patterns (dedup Set, RAF batching, mutable accumulator) can be extracted as standalone utilities without coupling to a shared store factory.

### Question 3: Should the unified approach handle both windowing patterns?

**Finding: The patterns serve different purposes and should remain separate.**

- **Sessions (2000-event window)**: Events are a raw log. Old events are genuinely discardable — the display is forward-scrolling and reconnect replays from server. The window prevents unbounded memory growth during long-running sessions (hours/days).
- **Brainstorms (keep all)**: Messages are the core data model. Losing old messages would break wave grouping, convergence history, and synthesis context. Rooms are bounded by wave count (typically 3-5 waves, ~50-200 messages).

These are fundamentally different data lifecycle requirements. A unified windowing config would add complexity without benefit.

### Question 4: Does a shared store pattern make sense given event heterogeneity?

**Finding: No. The heterogeneity is structural, not incidental.**

Session events span 40+ types across 7 categories (agent, session, user, system, team, subagent, brainstorm). The `processEvent()` function in the brainstorm store is already 300+ lines for ~15 event types. A unified store processing 40+ types would be a maintenance nightmare.

More importantly, the two stores do fundamentally different things with events:

- **Brainstorm store**: Transforms events into domain state (event → model mutation)
- **Session stream**: Accumulates events as a log (event → append to array)

These are opposite patterns. Forcing them together would be over-abstraction.

### Question 5: Should the O(n) dedup be fixed independently?

**Finding: YES. This is the highest-value, lowest-risk improvement.**

The session stream's O(n) dedup is a concrete performance problem that can be fixed in isolation:

```typescript
// CURRENT: O(n) per event — 2000 comparisons at capacity
if (state.events.some((e) => e.id === action.event.id)) {
  return state;
}

// PROPOSED: O(1) per event
if (eventIdSet.has(action.event.id)) {
  return state;
}
```

This mirrors exactly what brainstorm already does with `msgDedupKeys`. The implementation pattern is proven.

## Recommendation: Targeted Improvements, Not Unification

Rather than a top-down unification, extract the proven performance patterns from brainstorms and apply them to sessions as standalone improvements.

### Phase 1: Quick Wins (1-2 hours each, no architecture change)

#### 1A. O(1) Event Dedup for Sessions

Add a module-level `Set<number>` to `use-session-stream.ts`:

```typescript
// Module-level dedup — not in reducer state to avoid render triggers
let sessionEventIds = new Set<number>();

// In reducer:
case 'APPEND_EVENT': {
  if (sessionEventIds.has(action.event.id)) {
    return state;
  }
  sessionEventIds.add(action.event.id);
  // ... rest of append logic
}

// In RESET handler:
case 'RESET':
  sessionEventIds = new Set<number>();
  return initialState;
```

**Impact**: O(n) → O(1) per event. At 2000 events, this eliminates ~2000 comparisons per append.

**Risk**: Low. Same pattern already proven in brainstorm store for months.

**Caveat**: Since `useSessionStream` can have multiple instances (session-detail, plan-panel, support-chat), the module-level Set would be shared. Options:

- (a) One Set per hook instance (WeakMap keyed by session ID)
- (b) Map<sessionId, Set<number>> with cleanup on RESET
- (c) Keep in reducer state but use a Set instead of array scan

Option (b) is cleanest:

```typescript
const sessionDedupSets = new Map<string, Set<number>>();

function getDedupSet(sessionId: string): Set<number> {
  let set = sessionDedupSets.get(sessionId);
  if (!set) {
    set = new Set<number>();
    sessionDedupSets.set(sessionId, set);
  }
  return set;
}

function clearDedupSet(sessionId: string): void {
  sessionDedupSets.delete(sessionId);
}
```

#### 1B. RAF Batching for Session Catchup

Wrap session event dispatch in the same RAF pattern brainstorm uses. This would go in `use-session-stream.ts`'s `onMessage` callback:

```typescript
const batchRef = useRef<AgendoEvent[]>([]);
const rafRef = useRef<number>(0);

const flushBatch = useCallback(() => {
  rafRef.current = 0;
  const batch = batchRef.current;
  batchRef.current = [];
  for (const event of batch) {
    dispatch({ type: 'APPEND_EVENT', event });
  }
}, []);

// In onMessage:
batchRef.current.push(parsed);
if (!rafRef.current) {
  rafRef.current = requestAnimationFrame(flushBatch);
}
```

**Impact**: During SSE catchup (reconnect replaying hundreds of events), this coalesces N dispatches into ~1 per frame. React batches `useReducer` dispatches within a single synchronous flush, so the reducer runs N times but React only re-renders once.

**Note**: React 18+ already batches state updates, so the primary win here is avoiding N synchronous reducer calls spread across N microtasks. RAF ensures they're all synchronous within one frame.

**Risk**: Low. Need to handle cleanup (cancel RAF on unmount, flush pending events).

### Phase 2: Extract Shared Utilities (Optional, 2-3 hours)

If Phase 1 proves valuable, extract the common patterns into shared utilities:

#### 2A. `createDedupSet()` utility

```typescript
// src/lib/utils/dedup-set.ts
export function createDedupSet<K = number>() {
  const sets = new Map<string, Set<K>>();
  return {
    has: (scope: string, key: K) => sets.get(scope)?.has(key) ?? false,
    add: (scope: string, key: K) => {
      let set = sets.get(scope);
      if (!set) {
        set = new Set();
        sets.set(scope, set);
      }
      set.add(key);
    },
    clear: (scope: string) => sets.delete(scope),
  };
}
```

Used by both session stream (keyed by event ID) and brainstorm store (keyed by message composite key).

#### 2B. `createRAFBatcher()` utility

```typescript
// src/lib/utils/raf-batcher.ts
export function createRAFBatcher<T>(onFlush: (batch: T[]) => void): {
  push: (item: T) => void;
  cancel: () => void;
  flush: () => void;
} {
  let batch: T[] = [];
  let rafId = 0;

  function flush() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    if (batch.length === 0) return;
    const items = batch;
    batch = [];
    onFlush(items);
  }

  return {
    push: (item: T) => {
      batch.push(item);
      if (!rafId) {
        rafId = requestAnimationFrame(flush);
      }
    },
    cancel: () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      batch = [];
    },
    flush,
  };
}
```

#### 2C. Shared `useRealtimeStream()` hook (optional)

A thin wrapper around `useEventSource` that adds RAF batching and dedup:

```typescript
export function useRealtimeStream<E extends { id: number }>(options: {
  url: string | null;
  scopeId: string;
  onEvent: (event: E) => void;
  onBatch?: (events: E[]) => void;
  onStatusEvent?: (event: E) => void;
  isTerminalEvent?: (event: E) => boolean;
}) { ... }
```

This would replace the duplicated SSE → dispatch wiring in both `use-session-stream.ts` and `use-brainstorm-stream.ts`.

### Phase 3: Zustand Migration (Only If Needed)

**Trigger**: When session state needs multi-component sharing beyond the current parent-child pattern.

**Approach**: Create `session-store.ts` following brainstorm-store patterns:

- Per-session store instances (not a singleton)
- `processEvent()` mutates in-place for batch efficiency
- Selective `set()` calls based on event type
- Module-level dedup Set
- Atomic selectors for consumers

**Migration path**: Incremental. Replace `useSessionStream` with `useSessionStore` one consumer at a time. The hook's return type (`events`, `sessionStatus`, `permissionMode`, `isConnected`, `error`) would remain the same — consumers don't need to change.

## Performance Analysis

### Current Session Performance (Estimated)

| Operation             | Complexity                        | At 2000 events                      |
| --------------------- | --------------------------------- | ----------------------------------- |
| Event append dedup    | O(n) `.some()`                    | ~2000 comparisons                   |
| Event append window   | O(n) array spread + slice         | ~2000 element copy                  |
| Catchup (500 events)  | 500 × O(n) dedup + 500 dispatches | ~250K comparisons, 500 re-renders\* |
| `buildDisplayItems()` | O(n) forward scan                 | ~2000 event scan per render         |

\*React 18 batches within sync context, but SSE events arrive asynchronously.

### Proposed Session Performance (After Phase 1)

| Operation             | Complexity                            | At 2000 events              |
| --------------------- | ------------------------------------- | --------------------------- |
| Event append dedup    | O(1) Set.has()                        | 1 lookup                    |
| Event append window   | O(n) array spread + slice (unchanged) | ~2000 element copy          |
| Catchup (500 events)  | 500 Set lookups + ~1 RAF flush        | 500 lookups, ~1 re-render   |
| `buildDisplayItems()` | O(n) forward scan (unchanged)         | ~2000 event scan per render |

### Brainstorm Performance (Current, Reference)

| Operation            | Complexity                           | Notes                               |
| -------------------- | ------------------------------------ | ----------------------------------- |
| Message dedup        | O(1) Set.has()                       | Module-level `msgDedupKeys`         |
| Batch process        | O(n) single pass, 1 `set()`          | Mutable accumulator pattern         |
| Catchup (200 events) | 1 RAF flush → 1 `handleEventBatch()` | Single re-render                    |
| Wave grouping        | O(n) `useMemo`                       | Only on `messages` reference change |

## Impact on Existing Components

### Phase 1 Changes

| Component                      | Change Required                              |
| ------------------------------ | -------------------------------------------- |
| `use-session-stream.ts`        | Add dedup Set + RAF batching (internal only) |
| `session-detail-client.tsx`    | None (same hook API)                         |
| `plan-conversation-panel.tsx`  | None                                         |
| `support-chat-popup.tsx`       | None                                         |
| `use-multi-session-streams.ts` | Same dedup Set pattern (separate change)     |
| `session-chat-view.tsx`        | None                                         |
| `use-team-state.ts`            | None                                         |

### Phase 2 Changes

| Component                  | Change Required                             |
| -------------------------- | ------------------------------------------- |
| `use-session-stream.ts`    | Import shared `createRAFBatcher`            |
| `use-brainstorm-stream.ts` | Import shared `createRAFBatcher` (refactor) |
| `brainstorm-store.ts`      | Import shared `createDedupSet` (refactor)   |

### Phase 3 Changes (If Triggered)

| Component                     | Change Required                                                       |
| ----------------------------- | --------------------------------------------------------------------- |
| `session-detail-client.tsx`   | Replace `useSessionStream()` with `useSessionStore()`                 |
| `plan-conversation-panel.tsx` | Same                                                                  |
| `support-chat-popup.tsx`      | Same                                                                  |
| `use-team-state.ts`           | Could subscribe directly to store instead of receiving events as prop |

## Decision

**Adopt Phase 1 (O(1) dedup + RAF batching for sessions) as immediate improvements.**

Phase 2 (shared utilities) is optional cleanup — do it when touching these files for other reasons.

Phase 3 (Zustand migration) is deferred until a concrete multi-consumer need arises. The current `useReducer` pattern is correct for sessions' single-consumer topology.

## Trade-offs

### Chosen Approach (Targeted Fixes)

- **Pro**: Low risk, immediate performance benefit, no API changes
- **Pro**: Each phase is independent — can stop at Phase 1
- **Pro**: Doesn't force artificial unification on naturally different domains
- **Con**: Two different state patterns remain in the codebase
- **Con**: New developers need to understand both patterns

### Rejected: Full Zustand Unification

- **Pro**: Single pattern to learn
- **Con**: Over-engineering for sessions' current single-consumer topology
- **Con**: Forces brainstorm's domain model pattern onto sessions' event log pattern
- **Con**: High migration risk for marginal architectural benefit
- **Con**: Would likely result in a generic store that's harder to understand than either specific implementation

### Rejected: Keep Status Quo

- **Pro**: Zero risk
- **Con**: O(n) dedup is a real performance issue at scale
- **Con**: Missing RAF batching means unnecessary re-renders during catchup
- **Con**: Proven patterns from brainstorm sit unused in sessions

## Implementation Tasks

1. **[Phase 1A] Add O(1) event dedup to `use-session-stream.ts`** (~1 hour)
   - Add `Map<sessionId, Set<number>>` module-level dedup
   - Replace `.some()` with `.has()`
   - Clear on RESET and sessionId change
   - Add to `use-multi-session-streams.ts` too

2. **[Phase 1B] Add RAF batching to `use-session-stream.ts`** (~1-2 hours)
   - Add `batchRef` + `rafRef` pattern from brainstorm
   - Handle cleanup on unmount (cancel RAF, flush pending)
   - Test with reconnect scenario (batch + dedup interaction)

3. **[Phase 2] Extract shared utilities** (~2-3 hours, optional)
   - `src/lib/utils/dedup-set.ts`
   - `src/lib/utils/raf-batcher.ts`
   - Refactor both session and brainstorm to use shared utilities

4. **[Phase 3] Zustand migration** (deferred, ~1-2 days when triggered)
   - Create `src/stores/session-store.ts`
   - Migrate consumers incrementally
   - Remove `use-session-stream.ts` reducer
