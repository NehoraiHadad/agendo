# Agent Team Canvas: Infrastructure Research

**Author:** Claude Code (Research Agent)
**Date:** 2026-03-22
**Task:** Research event infrastructure + canvas library selection
**Status:** COMPLETE

---

## Executive Summary

This document covers the existing Agendo infrastructure relevant to building an Agent Team Canvas feature: the real-time event system, SSE connection model, brainstorm room UI patterns, and team state infrastructure. It evaluates canvas library options with a final recommendation.

**Bottom line:** React Flow (`@xyflow/react`) is the correct choice. It is the only option that handles edges, zoom/pan, custom nodes, and interactive drag-and-drop without substantial hand-rolled engineering. This aligns with the parallel design document (`agent-team-canvas-design.md`) which has already committed to React Flow.

---

## 1. AgendoEvent Types

All events are defined in `src/lib/realtime/event-types.ts`. Every event shares a base of `{ id: number, sessionId: string, ts: number }`.

### Team-Specific Events (Primary Source for Canvas)

| Event                     | Payload Shape                                                                                                       | Volume                                                                                             | Canvas Use                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `team:config`             | `teamName, members[]` (name, agentId, agentType, model, color, planModeRequired, joinedAt, tmuxPaneId, backendType) | **Very low** — once per team attach/member join                                                    | Initialize nodes on canvas; source of member metadata          |
| `team:message`            | `fromAgent, text, summary, color, sourceTimestamp, isStructured, structuredPayload`                                 | **Low-medium** — structured payloads: idle_notification, permission_request, task_assignment, etc. | Edge animation: teammate → lead; status updates; tool activity |
| `team:outbox-message`     | `toAgent, fromAgent, text, summary, isStructured, structuredPayload`                                                | **Low** — lead → teammate messages                                                                 | Edge animation: lead → teammate; task assignment visualization |
| `team:task-update`        | `tasks[]` — full snapshot: id, subject, status, owner, blocks[], blockedBy[]                                        | **Very low** — full replacement on change                                                          | Task board sidebar; dependency edges between tasks             |
| `subagent:start`          | `agentId, toolUseId, subagentType?, description?`                                                                   | **Low**                                                                                            | Spawn child node in canvas                                     |
| `subagent:progress`       | `agentId, eventType (tool_use/text/result), toolName?, summary?`                                                    | **Medium**                                                                                         | Update child node activity                                     |
| `subagent:complete`       | `agentId, toolUseId, success`                                                                                       | **Low**                                                                                            | Mark child node done/failed                                    |
| `agent:subagent-progress` | `taskId, description, summary?, usage?`                                                                             | **Medium**                                                                                         | Subagent card activity display                                 |

### Agent Activity Events (Individual Session Streams)

These require subscribing to individual agent session SSE streams (see §2). They provide richer real-time granularity than team:message.

| Event                    | Volume   | Monitoring Value                                                        |
| ------------------------ | -------- | ----------------------------------------------------------------------- |
| `agent:tool-start`       | Medium   | ⭐⭐⭐ Show active tool badge on node                                   |
| `agent:tool-end`         | Medium   | ⭐⭐⭐ Duration + result; clear tool badge                              |
| `agent:text`             | Medium   | ⭐⭐ Last response preview                                              |
| `agent:text-delta`       | **HIGH** | ⭐ Token streaming — suppress in canvas (use only for detail panel)     |
| `agent:thinking`         | Medium   | ⭐⭐ Thinking indicator                                                 |
| `agent:thinking-delta`   | **HIGH** | ⭐ Suppress in canvas                                                   |
| `agent:result`           | Low      | ⭐⭐⭐ Turn cost, tokens, duration — show in node footer                |
| `agent:activity`         | Medium   | ⭐⭐ `thinking: boolean` — pulse animation                              |
| `agent:tool-approval`    | Low      | ⭐⭐⭐ Approval request — show warning badge, unblock indicator         |
| `agent:plan`             | Low      | ⭐⭐ Plan entries for plan-mode agents                                  |
| `agent:usage`            | Low      | ⭐⭐ Context window usage bar                                           |
| `session:state`          | Low      | ⭐⭐⭐ active/awaiting_input/idle/ended — critical for node status ring |
| `session:init`           | Once     | ⭐⭐ model, mcpServers, permissionMode                                  |
| `session:mode-change`    | Low      | ⭐⭐ Live permission mode updates                                       |
| `system:git-context`     | Low      | ⭐ Branch/commit info for node tooltip                                  |
| `system:file-contention` | Rare     | ⭐⭐⭐ Cross-agent file conflicts — critical warning edge               |
| `system:rate-limit`      | Rare     | ⭐⭐⭐ Show blocked indicator on node                                   |

### Event Classification: High vs. Low Volume

**High volume (suppress or aggregate in canvas):**

- `agent:text-delta` — token-level streaming; should only display in per-agent detail panel
- `agent:thinking-delta` — same
- `agent:tool-progress` — intermediate tool output chunks

**Low volume (safe to react to directly):**

- All `team:*` events
- `session:state`, `agent:result`, `agent:tool-start/end`
- `agent:activity` (thinking boolean)

---

## 2. SSE Infrastructure

### Core Hook: `useEventSource` (`src/hooks/use-event-source.ts`)

A general-purpose EventSource wrapper with:

- **Exponential backoff reconnect**: 1s → 30s max delay
- **lastEventId tracking**: sends `?lastEventId=N` on reconnect so server replays missed events from log file
- **Named event type support** via `eventNames[]` option
- **Clean lifecycle**: `markDone()` permanently closes, `isMountedRef` guards stale dispatches

### Session Stream Hook: `useSessionStream` (`src/hooks/use-session-stream.ts`)

Wraps `useEventSource` with:

- **MAX_EVENTS = 2000** rolling window (prevents memory growth)
- **RAF batching** (`createRAFBatcher`): groups events within a single animation frame for one dispatch
- **O(1) dedup** (`createScopedDedup`): module-level Map keyed by sessionId; prevents duplicate events on reconnect
- **30s polling fallback** for session status (in case SSE misses a status change)
- **Session:state fast path**: status events bypass the batcher (immediate UI update)

### Multi-Session Strategy for Team Canvas

The current architecture assumes one session per `useSessionStream` instance. For a team canvas monitoring N agents, two approaches are viable:

#### Approach A: N Concurrent useSessionStream Instances (Recommended)

```tsx
// In a canvas Zustand store or hook:
const sessionIds = teamMembers.map((m) => m.sessionId).filter(Boolean);
// Each member has its own hook in a child component or via a custom multi-stream hook
```

**Performance analysis:**

- Each EventSource = one persistent HTTP/2 multiplexed stream
- HTTP/2 supports ~100+ concurrent streams on a single connection
- N=5–10 agents: negligible overhead on both client and server
- Each hook has its own RAF batcher + dedup state (correct isolation)
- Total memory: ~2000 events × N sessions — acceptable for typical team sizes (≤10)

**Key design rule:** High-volume events (`agent:text-delta`, `agent:thinking-delta`) should be filtered at the canvas level. These streams still connect but their events are dropped unless an agent's detail panel is open.

#### Approach B: New `useTeamStream` Multiplexing Hook

A single hook that maintains N EventSource connections and routes events to a shared canvas store keyed by sessionId. More complex but avoids prop-drilling.

**Recommendation:** Start with Approach A (N individual hooks per member component). Migrate to Approach B if performance issues emerge (unlikely for ≤10 members).

### SSE Catchup / Reconnection

The server sends a full history replay when `lastEventId=0` (fresh connect). On reconnect with `lastEventId=N`, only events after N are replayed. The `useSessionStream` hook resets `lastEventId` to 0 on deliberate reconnect (e.g., new sessionId). Canvas should handle this gracefully — derive state from the full event stream rather than incremental updates.

---

## 3. Brainstorm Room UI — Reference Patterns

**Files:** `src/components/brainstorms/room-client.tsx`, `src/stores/brainstorm-store.ts`, `src/components/brainstorms/participant-sidebar.tsx`

### Architecture Pattern

```
BrainstormWithDetails (server)
  → setRoom() → Zustand store
  → useBrainstormStream() → SSE → handleEvent() / handleEventBatch()
  → RoomView (main feed)  +  ParticipantSidebar (agent status list)
```

### Key Patterns to Reuse

| Pattern                           | Brainstorm Implementation                                                 | Team Canvas Adaptation                                                   |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Mutable state accumulator         | `MutableState` + `processEvent()` mutates in-place; single `set()` at end | Use same pattern for canvas store; avoids O(n) re-renders during catchup |
| Batch event processing            | `handleEventBatch()` clones state once, loops N events, single set()      | Apply to initial SSE replay for all N agent sessions                     |
| Participant state Map             | `Map<participantId, ParticipantState>`                                    | `Map<sessionId, AgentNodeState>` for canvas nodes                        |
| Status indicators                 | `StatusIndicator` + `StatusLabel` components with Tailwind CSS            | Reuse or adapt for LiveAgentCard — same status vocabulary                |
| AgentAvatar                       | `src/components/shared/agent-avatar.tsx`                                  | Use directly in canvas nodes                                             |
| Streaming text dedup              | Module-level `Set<string>` for message keys                               | Same dedup pattern for events across N session streams                   |
| useSyncExternalStore client guard | Prevents SSR mismatch for Zustand in Next.js 16                           | Required for canvas (uses browser APIs: EventSource, ResizeObserver)     |
| Mobile Sheet sidebar              | `Sheet` from shadcn/ui for mobile participant panel                       | Use for mobile "agent detail" sheet on canvas tap                        |

### What Brainstorms Does NOT Use

- **No canvas/graph rendering** — just vertical chat + sidebar list
- **No edges** between participants (brainstorm is parallel, not networked)
- **No drag-drop** for participant positioning
- This is exactly why we need a new canvas approach for Team Canvas

---

## 4. Team State Infrastructure

### Existing: `useTeamState` (`src/hooks/use-team-state.ts`)

Derives structured team state from the flat `AgendoEvent[]` array. Already provides:

| Data                                                                                                   | Source                         | Canvas Use                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------- |
| `members[]` (name, agentId, agentType, model, color, status, toolEvents, recentTools, currentActivity) | `team:config` + `team:message` | Node metadata                 |
| `tasks[]` (id, subject, status, owner, blocks, blockedBy)                                              | `team:task-update`             | Task nodes + dependency edges |
| `subagents[]` (agentId, toolUseId, subagentType, description, status)                                  | `subagent:start/complete`      | Child nodes                   |
| `messagesByAgent` / `outboxByAgent`                                                                    | `team:message/outbox-message`  | Message thread panels         |

### Gaps for Canvas Visualization

The current `useTeamState` derives state **only from the team-lead's SSE stream** (which carries `team:*` events). It does NOT:

| Gap                                                               | Impact                                                  | Resolution                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- |
| No per-session `agent:tool-start/end` events                      | Can't show live tool activity on canvas nodes           | Subscribe to individual session streams                               |
| No token/cost data per agent                                      | Can't show context window usage bars                    | Get from `agent:result` and `agent:usage` per session                 |
| No `session:state` per agent                                      | Can't show active/awaiting_input/idle/ended status ring | From individual session streams                                       |
| No canvas node positions                                          | Can't persist layout between refreshes                  | Add to a `useTeamCanvasStore` (Zustand), localStorage for persistence |
| Tool activity limited to `permission_request` structured messages | Indirect + delayed vs. direct `agent:tool-start`        | Use individual session streams for directness                         |

### Recommended State Architecture for Canvas

```
useTeamCanvasStore (Zustand)
  ├── teamState (from useTeamState — existing, free)
  ├── nodePositions: Map<agentId, { x, y }>  — canvas layout
  ├── agentSessionEvents: Map<sessionId, AgendoEvent[]>  — per-session events
  └── selectedNodeId: string | null

// Per-member: useSessionStream(member.sessionId) → feeds agentSessionEvents
```

---

## 5. Canvas Library Evaluation

### What the Canvas Needs

1. Agent nodes as cards (custom React components)
2. Directed edges: communication arrows between agents
3. Dependency edges: task → agent assignments
4. Live status updates without full re-renders
5. Drag-and-drop node repositioning
6. Zoom and pan
7. Optional: mini-map, auto-layout

### Option A: React Flow (`@xyflow/react`) ⭐ RECOMMENDED

**Status:** NOT installed. Must add to `package.json`.

**Bundle size:**

- `@xyflow/react`: ~130KB gzipped
- `@xyflow/system`: ~30KB gzipped (pulled as dependency)
- **Total addition: ~160KB gzipped**
- Mitigation: Next.js `dynamic(() => import('./team-canvas'), { ssr: false })` lazy-loads on route entry

**Dependencies analysis:**

- `zustand` — ✅ already installed (v5)
- `classcat` — small utility, no conflicts
- `@xyflow/system` — pulled automatically

**Pros:**
| Feature | Status |
|---------|--------|
| Custom node components (JSX) | ✅ First-class support — `nodeTypes` map |
| Directed/animated edges | ✅ Built-in, fully customizable |
| Drag-drop repositioning | ✅ Built-in, no extra library |
| Zoom + pan | ✅ Built-in via `<ReactFlow>` |
| Mini-map | ✅ `<MiniMap>` component |
| Controls (zoom in/out/fit) | ✅ `<Controls>` component |
| TypeScript support | ✅ Full, strict types |
| React 19 compatible | ✅ v12.x supports React 18/19 |
| Server-side rendering | ✅ With `ssr: false` dynamic import |
| Edge routing algorithms | ✅ Smoothstep, bezier, straight built-in |
| Auto-layout support | ⚠️ Needs `dagre` or `elkjs` for auto-arrange |
| Community + maintenance | ✅ ~24k GitHub stars, weekly releases |

**Cons:**

- ~160KB bundle addition (mitigated by lazy loading)
- New dependency (one more package to maintain)
- "Full-feature" API surface — requires learning the node/edge model

**Key fit for Agendo:**

- Custom node API maps perfectly to `LiveAgentCard` with status ring, tool badge, model label, usage bar
- Zustand already in project — React Flow's internal store won't conflict (it creates its own instance)
- Animated edges (`animated: true`) give instant visual feedback for message flow
- `useNodesState`/`useEdgesState` hooks integrate cleanly with our Zustand canvas store

**Code sketch:**

```tsx
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const nodeTypes = { agentNode: LiveAgentCard };

function LiveCanvasView({ teamState }: { teamState: TeamState }) {
  const [nodes, , onNodesChange] = useNodesState(buildNodes(teamState));
  const [edges] = useEdgesState(buildEdges(teamState));

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      colorMode="dark"
    >
      <Background variant="dots" />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );
}
```

---

### Option B: Custom SVG + framer-motion

**Status:** framer-motion NOT installed. Must add.

**Bundle size:**

- `framer-motion`: ~50KB gzipped
- **Total addition: ~50KB** — but this only buys animations, not the graph primitives

**What we still need to implement from scratch:**

- ✗ Edge routing (SVG `<path>` with bezier curves — non-trivial)
- ✗ Pan/zoom (CSS transforms + pointer events)
- ✗ Node drag-drop (need `@dnd-kit` — already installed but needs canvas coordinate transforms)
- ✗ Mini-map (scale-transformed duplicate viewport)
- ✗ Hit-testing for zoom/pan + drag conflict

**Pros:**

- Full control over visual appearance
- Can perfectly match Agendo's dark `oklch(0.085 0 0)` aesthetic
- Animations via framer-motion spring physics

**Cons:**

- 3–4x more implementation code
- Edge routing is notoriously tricky (especially with dynamic nodes)
- Zoom + pan + drag = complex coordinate system bugs
- framer-motion 50KB doesn't buy graph primitives — we'd need it just for animations
- Maintenance burden: any layout change means updating routing logic

**Verdict:** Only viable if bundle size is an absolute hard limit, or for a static/list-based view. For a full interactive canvas, the custom approach is disproportionately expensive in engineering time.

---

### Option C: react-grid-layout (ALREADY INSTALLED)

**Status:** ✅ Already in `package.json` AND `node_modules`. Version `2.2.2`.

**Dependencies:** `react-draggable`, `react-resizable`, `clsx`, `fast-equals` (all transitively installed).

**Bundle size:** 0 additional bytes — already loaded.

**What it provides:**

- Draggable + resizable grid cells
- Responsive breakpoint layouts
- Serializable layout state

**What it does NOT provide:**

- Free-form (non-grid) positioning
- Edges/connections between cells
- Zoom and pan
- Mini-map
- Curved connection lines

**Assessment:** react-grid-layout is a **dashboard grid** library, not a graph library. It could work for a "dashboard-style" team view where agents are in fixed grid slots with no edges — but the team canvas design explicitly requires edges for communication arrows and dependency visualization. Grid layout would require a full SVG overlay for edges, re-creating most of the complexity of Option B.

**Best use:** Build mode's agent palette or a compact "status dashboard" fallback on mobile.

---

### Option D: @dnd-kit (ALREADY INSTALLED) + Plain SVG

**Status:** ✅ `@dnd-kit/core` (v6.3.1), `@dnd-kit/sortable`, `@dnd-kit/utilities` already installed.

**Bundle size:** 0 additional bytes.

**What it provides:**

- Accessible drag-and-drop
- Pointer + keyboard DnD
- Sortable lists and grids

**What it does NOT provide:**

- Edge rendering
- Zoom/pan
- Free-form canvas coordinates
- Any graph primitives

**Assessment:** @dnd-kit is ideal for the agent palette in Build Mode (drag from palette → canvas). It is NOT a canvas library. Would need the same SVG edge overhead as Option C. Not a standalone solution.

---

### Option E: d3-force / elkjs

**Status:** Neither installed.

**d3-force:**

- Force-directed auto-layout
- Good for exploration/discovery views
- Poor for controlled positioning (agents move constantly)
- ~100KB for d3-force

**elkjs:**

- Eclipse Layout Kernel (hierarchical/DAG auto-layout)
- Used by React Flow as an optional layout plugin
- ~300KB — large
- Overkill as a standalone canvas, best used as React Flow's layout engine

**Verdict:** These are layout algorithms, not canvas rendering frameworks. If React Flow is chosen, elkjs can optionally be added later for auto-layout (`@xyflow/elkjs` wrapper).

---

### Reaflow

- Purpose-built for read-only DAG/flow diagrams
- Less interactive than React Flow (drag-drop limited)
- Smaller community, less active maintenance
- Uses elkjs internally
- Not suitable for the interactive build+monitor dual-mode canvas

---

## 6. Bundle Size Analysis

### Current State

```bash
$ du -sh node_modules/@xyflow    # NOT_INSTALLED
$ du -sh node_modules/framer-motion  # NOT_INSTALLED
$ du -sh node_modules/@dnd-kit   # 16KB (installed, used for Kanban)
$ du -sh node_modules/react-grid-layout  # 4.0KB (installed, stub/link)
```

### Projected Impact

| Option                     | New Bundle (gzipped) | Notes                                                  |
| -------------------------- | -------------------- | ------------------------------------------------------ |
| React Flow                 | ~160KB               | Lazy loaded with `dynamic()`, only on /teams/\* routes |
| framer-motion only         | ~50KB                | Doesn't provide graph primitives                       |
| react-grid-layout          | 0KB                  | Already installed, limited capabilities                |
| @dnd-kit (additional)      | 0KB                  | Already installed, not a canvas                        |
| elkjs (auto-layout add-on) | ~300KB               | Optional add-on for React Flow, not required           |

### Lazy Loading Strategy (React Flow)

```tsx
// In the team canvas page:
import dynamic from 'next/dynamic';

const TeamCanvas = dynamic(
  () => import('@/components/teams/team-canvas').then((m) => m.TeamCanvas),
  {
    ssr: false, // React Flow uses browser APIs
    loading: () => <TeamCanvasSkeleton />,
  },
);
```

This ensures React Flow's ~160KB is only loaded when the user navigates to a team canvas route, not on initial page load. Given Agendo's average 3–5 route navigation depth before reaching a team canvas, this is an acceptable trade-off.

---

## 7. Recommendation Summary Table

| Criterion             | React Flow      | Custom SVG+FM     | react-grid-layout | @dnd-kit+SVG      |
| --------------------- | --------------- | ----------------- | ----------------- | ----------------- |
| Installation cost     | Add 1 package   | Add 1 package     | Already installed | Already installed |
| Bundle size           | ~160KB lazy     | ~50KB             | 0KB               | 0KB               |
| Edges/connections     | ✅ Built-in     | ✅ Manual SVG     | ❌ SVG overlay    | ❌ SVG overlay    |
| Custom node JSX       | ✅ Native       | ✅ Native         | ✅ Native         | ✅ Native         |
| Drag repositioning    | ✅ Built-in     | ✅ @dnd-kit       | ✅ Built-in       | ✅ Native         |
| Zoom + pan            | ✅ Built-in     | ✅ Manual         | ❌                | ❌                |
| Mini-map              | ✅ Built-in     | ✅ Manual         | ❌                | ❌                |
| Auto-layout           | ⚠️ elkjs opt-in | ❌ Custom         | ❌                | ❌                |
| Implementation effort | Low             | **Very High**     | Medium            | **Very High**     |
| Maintenance burden    | Low             | High              | Medium            | High              |
| React 19 support      | ✅              | ✅                | ✅                | ✅                |
| TypeScript quality    | ✅ Excellent    | ✅ (manual types) | ✅ Good           | ✅ Excellent      |
| Community/docs        | ✅ Excellent    | N/A               | ✅ Good           | ✅ Excellent      |

---

## 8. Recommended Approach

### Primary: React Flow (`@xyflow/react`) with Next.js Dynamic Import

**Justification:**

1. **Exact fit for the problem space.** Agent team topology is a directed graph — agents are nodes, communication channels are edges. React Flow is purpose-built for interactive node-edge graphs. The alternatives require reinventing this from scratch.

2. **Dual-mode canvas.** The feature requires both Build Mode (interactive construction) and Monitor Mode (live visualization). React Flow's `onNodesChange`/`onEdgesChange` callbacks handle both with the same node-type system.

3. **The design agent already chose React Flow.** The parallel design document (`planning/agent-team-canvas-design.md`) specifies `<CanvasWorkspace (React Flow)>` and `<LiveCanvasView (React Flow)>`. Converging on the same choice avoids integration friction.

4. **Zustand alignment.** React Flow uses Zustand v5 internally — the exact version already in the project. No dependency conflicts. React Flow creates its own isolated Zustand store instance; there is no global store collision.

5. **Bundle cost is manageable.** 160KB lazy-loaded on a dedicated route (`/teams/[taskId]`) is well within acceptable bounds for a modern web app. The server has 16GB RAM; the bundle size concern is about browser parsing time, not server memory.

6. **Custom node API maps cleanly to LiveAgentCard.** The `nodeTypes` map allows passing arbitrary React components as nodes, meaning `LiveAgentCard` can render the same status ring, tool badge, model chip, and usage bar used in the existing `TeamPanel` — just inside a React Flow node wrapper.

7. **Animated edges for message flow.** Setting `animated: true` on an edge gives immediate visual feedback when agents send messages — no custom CSS needed.

### Supplementary: react-grid-layout for Agent Palette (Build Mode)

`react-grid-layout` is already installed and ideal for the **Build Mode agent palette** — the draggable list of available agents on the left side. It handles grid snapping and responsive layout without additional cost.

### Supplementary: @dnd-kit for Palette → Canvas DnD

The existing `@dnd-kit` installation handles dragging an agent from the palette onto the React Flow canvas (using React Flow's `onDrop`/`onDragOver` API).

---

## 9. Multi-Session SSE — Implementation Guidance

### Hook Strategy

```tsx
// New hook: src/hooks/use-team-canvas-stream.ts
//
// For each team member with an active session:
//   - Create one useSessionStream(member.sessionId) instance
//   - Filter out high-volume events (text-delta, thinking-delta)
//   - Route filtered events to useTeamCanvasStore

function useTeamCanvasStream(members: TeamMember[]) {
  // Dynamically mount N session streams
  // Each stream's events feed into agentSessionEvents Map in store
}
```

### Performance Rules for Canvas

1. **Never render `agent:text-delta` events on the canvas.** Aggregate them in the per-agent detail sheet only.
2. **Throttle `agent:tool-progress` to 500ms** — intermediate tool output is not useful at canvas granularity.
3. **Derive node state with `useMemo`** — never compute `buildNodes(teamState)` inline in render.
4. **Use React Flow's built-in `memo` for node components** — wrap `LiveAgentCard` with `React.memo`.
5. **Limit canvas to ≤20 nodes** before switching to list view — React Flow handles more but visual clarity degrades.

### Event → Canvas State Mapping

```
team:config               → initialize nodes, set team name
session:state (per agent) → update node status ring color
agent:activity            → pulse animation on node
agent:tool-start          → show tool badge on node
agent:tool-end            → clear tool badge, log to tool history
agent:result              → update turn count, cost badge
team:message (inbound)    → animate edge: member → lead
team:outbox-message       → animate edge: lead → member
team:task-update          → update task sidebar
subagent:start            → create child node
subagent:complete         → update child node status
system:file-contention    → red warning edge between conflicting agents
system:rate-limit         → amber rate-limit badge on node
```

---

## 10. Gaps Identified (For Implementation Agent)

1. **`useTeamCanvasStream` hook doesn't exist yet** — needs to be built to multiplex N session SSE streams and feed filtered events to the canvas store.

2. **No canvas Zustand store** — `useTeamState` provides team structure but not canvas-specific state (node positions, selected node, viewport). A new `useTeamCanvasStore` is needed.

3. **Node position persistence** — React Flow node positions need to be saved (localStorage for now, eventually DB) so the layout survives page refresh.

4. **Session ID → agent mapping** — `TeamMember` has `agentId` (from the team config) but the canvas also needs `sessionId` to subscribe to the correct SSE stream. The session for each team member must be discoverable (via API or from existing session-related events).

5. **Build Mode has no existing CRUD** — creating a team (agent selection, prompt config, dependency graph) requires new API endpoints and DB schema beyond what the research covers. The design document (`agent-team-canvas-design.md`) outlines the component tree; implementation details are in scope for the backend agent.

6. **Auto-layout** — For Build Mode initial layout, a simple horizontal/vertical grid arrangement will suffice. For complex DAGs, `dagre` (~30KB) via React Flow's official plugin (`@xyflow/layout-options`) can be added later.

---

_Research complete. Ready for implementation._
