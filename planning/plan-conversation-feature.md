# Plan Conversation — Co-Planning with an AI Agent

## Summary

Add a conversation side panel to the Plan Detail page (`/plans/[id]`). The user opens a chat with an AI agent to co-create the plan — the agent reads the codebase, suggests edits, and the user approves/rejects changes. The plan content in the editor updates live as suggestions are accepted.

## Context

The plan detail page already exists at `src/app/(dashboard)/plans/[id]/plan-detail-client.tsx`. It has:

- Split editor/preview with `ViewMode` toggle (edit/preview/split)
- Auto-save (debounced 2s), Ctrl+S, save on blur
- Title editing, status badge, Validate/Execute/Archive actions
- State: `plan`, `content`, `isDirty`, `isSaving`, `viewMode`

The session infrastructure already supports creating conversation sessions, SSE streaming, and message sending.

## Architecture

```
┌───────────────────────────────────┬───────────────────┐
│  Plan Editor (existing)           │  Agent Chat Panel  │
│                                   │  (new, w-96)       │
│  ## Implementation Plan           │                    │
│  - Step 1: Add auth middleware    │  Agent: I looked   │
│  - Step 2: Create login page      │  at the codebase.  │
│  + Step 3: Add rate limiting      │  You should also   │
│                                   │  add rate limiting  │
│  [Edit] [Split] [Preview]        │                    │
│                                   │  ┌──────────────┐  │
│                                   │  │ Suggested     │  │
│                                   │  │ edit (diff)   │  │
│                                   │  │ [Apply][Skip] │  │
│                                   │  └──────────────┘  │
│                                   │                    │
│                                   │  [Type message...] │
└───────────────────────────────────┴───────────────────┘

Mobile (< 768px):
┌───────────────────────────────────┐
│  Plan Editor (full width)         │
│  [Chat button floating]           │
│                                   │
│  ┌─ Bottom Sheet (70vh) ─────────┐│
│  │  Agent Chat                   ││
│  │  ...messages...               ││
│  │  [Suggested edit]             ││
│  │  [Type message...]            ││
│  └───────────────────────────────┘│
└───────────────────────────────────┘
```

## Implementation Plan

### 1. Backend: Plan Conversation API

**File: `src/app/api/plans/[id]/conversation/route.ts`**

POST — Start or resume a plan conversation:

```typescript
// Request body
{ agentId: string; capabilityId: string }

// Behavior:
// 1. Get the plan
// 2. If plan.sourceSessionId exists and session is idle → resume it (send a message to re-engage)
// 3. Otherwise, create a new conversation session:
//    - kind: 'conversation'
//    - projectId: plan.projectId
//    - permissionMode: 'acceptEdits'  (can read code, can edit the plan content)
//    - initialPrompt: buildPlanConversationPrompt(plan)
// 4. Update plan.sourceSessionId = session.id
// 5. Enqueue the session
// 6. Return { sessionId }

GET — Get current conversation session for this plan:
// Returns { sessionId: string | null, status: SessionStatus | null }
// Looks up plan.sourceSessionId, returns its current status
```

**The initial prompt** should be:

```
You are helping the user co-create an implementation plan. Here is the current plan:

---
{plan.content}
---

Project: {project.name} (root: {project.rootPath})

Your role:
- Read and explore the codebase to understand the current state
- Suggest improvements, missing steps, or corrections to the plan
- When you want to edit the plan, output a PLAN_EDIT block:

<<<PLAN_EDIT
{the full updated plan content in markdown}
PLAN_EDIT>>>

The user will see your suggested edit as a diff and can accept or reject it.

- Answer questions about the codebase, architecture, feasibility
- Be specific — reference actual file paths, function names, patterns you find
- Keep suggestions practical and grounded in what the code actually looks like
```

### 2. Frontend: Plan Chat Panel Component

**File: `src/components/plans/plan-chat-panel.tsx`**

```typescript
interface PlanChatPanelProps {
  planId: string;
  projectId: string;
  currentContent: string; // current plan content from editor
  onApplyEdit: (newContent: string) => void; // callback to update editor
  onClose: () => void;
}
```

This component:

- On mount: GET `/api/plans/{planId}/conversation` to check for existing session
- If no session: show "Start conversation" button with agent picker
- If session exists: connect via `useSessionStream(sessionId)` and show chat
- Renders messages using a simplified version of the session chat view patterns
- Detects `<<<PLAN_EDIT ... PLAN_EDIT>>>` blocks in agent messages → renders as a diff card
- Diff card shows: visual diff (red/green lines), [Apply] and [Skip] buttons
- [Apply] calls `onApplyEdit(newContent)` which updates the editor content
- Has a message input at the bottom (reuse `SessionMessageInput` or build a simpler version)
- When user sends a message, POST to `/api/sessions/{sessionId}/message`

**Diff detection logic:**

```typescript
function extractPlanEdit(text: string): string | null {
  const match = text.match(/<<<PLAN_EDIT\n([\s\S]*?)\nPLAN_EDIT>>>/);
  return match ? match[1] : null;
}
```

**Diff rendering:** Use a simple line-by-line diff (split current content and suggested content by lines, mark added/removed/unchanged). Don't pull in a heavy diff library — a basic implementation is fine:

```typescript
// Show removed lines in red, added lines in green
// Group consecutive changes as "hunks" with 2 lines of context
```

### 3. Frontend: Integrate Panel into Plan Detail Page

**File: `src/app/(dashboard)/plans/[id]/plan-detail-client.tsx`** (modify)

Changes:

- Add state: `const [chatOpen, setChatOpen] = useState(false)`
- Add a "Chat with Agent" button (MessageSquare icon) in the header toolbar, next to the view mode toggles
- When `chatOpen`:
  - Desktop (md+): render `PlanChatPanel` as a right sidebar (`w-96`, flex-shrink-0)
  - Mobile: render as a bottom sheet (use shadcn Sheet component with `side="bottom"`)
  - The editor area shrinks to accommodate (flex layout handles this)
- `onApplyEdit` callback: updates `content` state + sets `isDirty = true` (triggers auto-save)
- When the agent sends a new message with a PLAN_EDIT block, the panel shows the diff card
- User clicks [Apply] → editor content updates live, auto-save kicks in

Layout change:

```tsx
// Current:
<div className="flex-1 flex ...">
  {/* editor */}
  {/* preview */}
</div>

// New:
<div className="flex-1 flex ...">
  <div className={cn("flex-1 flex ...", chatOpen && "md:mr-0")}>
    {/* editor */}
    {/* preview */}
  </div>
  {chatOpen && (
    <>
      {/* Desktop: side panel */}
      <div className="hidden md:flex w-96 border-l ...">
        <PlanChatPanel ... />
      </div>
      {/* Mobile: bottom sheet */}
      <Sheet open={chatOpen} onOpenChange={setChatOpen}>
        <SheetContent side="bottom" className="h-[70vh]">
          <PlanChatPanel ... />
        </SheetContent>
      </Sheet>
    </>
  )}
</div>
```

### 4. Frontend: Plan Edit Diff Card

**File: `src/components/plans/plan-edit-diff.tsx`**

```typescript
interface PlanEditDiffProps {
  currentContent: string;
  suggestedContent: string;
  onApply: () => void;
  onSkip: () => void;
  applied?: boolean; // already applied — show as muted
}
```

Renders:

- A card with "Suggested edit" header
- Line-by-line diff with red (removed) / green (added) highlighting
- Collapse long diffs (show first 10 lines + "Show N more")
- [Apply] button (primary, green tint) — calls onApply, then shows "Applied" state
- [Skip] button (ghost) — dismisses the suggestion
- Once applied, card becomes muted with a checkmark

### 5. Syncing Plan Content Bi-Directionally

When the user manually edits the plan while a conversation is active:

- On save (auto-save or Ctrl+S), if chatOpen and sessionId exists:
  - Send a system-style message to the agent: "The user updated the plan. Current content:\n\n{content}"
  - This keeps the agent in sync without the user having to copy-paste
- Implementation: in `saveContent()`, after successful PATCH, if `chatSessionId` exists, POST a message to the session

When the agent suggests an edit and the user applies it:

- `onApplyEdit(newContent)` sets `content` state
- `isDirty` becomes true → auto-save triggers
- No need to notify the agent — it knows what it suggested

### 6. MCP Integration (Optional Enhancement)

If the agent has MCP tools (mcp**agendo**\*), it can call `update_task` or `add_progress_note` during planning. The `acceptEdits` permission mode allows file reads but blocks bash and MCP tools.

However, for plan conversations specifically, we might want to allow the `mcp__agendo__update_task` tool so the agent can update the plan's associated task. Consider adding `allowedTools: ['mcp__agendo__*']` to the session creation.

Actually — since the agent edits the plan via the PLAN_EDIT protocol (parsed client-side), not via file writes, `acceptEdits` mode works fine. The agent reads code with Read/Glob/Grep tools (auto-approved) and "writes" the plan via structured text output (no tool needed).

## Files Summary

| Action | File                                                    | Description                            |
| ------ | ------------------------------------------------------- | -------------------------------------- |
| Create | `src/app/api/plans/[id]/conversation/route.ts`          | GET/POST plan conversation session     |
| Create | `src/components/plans/plan-chat-panel.tsx`              | Side panel chat component              |
| Create | `src/components/plans/plan-edit-diff.tsx`               | Diff card for suggested edits          |
| Modify | `src/app/(dashboard)/plans/[id]/plan-detail-client.tsx` | Add chat toggle + panel integration    |
| Modify | `src/lib/services/plan-service.ts`                      | Add `getOrCreateConversation()` helper |

## Key Decisions

1. **`acceptEdits` mode** — agent can read code but not run bash or modify files. Plan edits happen via structured text protocol, not file writes.
2. **Side panel on desktop, bottom sheet on mobile** — editor stays visible and editable during the conversation.
3. **`<<<PLAN_EDIT ... PLAN_EDIT>>>` protocol** — simple text markers the agent outputs when it wants to suggest a plan change. Parsed client-side into diff cards.
4. **Bi-directional sync** — when user manually edits, a message is sent to keep the agent in sync. When agent suggests and user applies, auto-save handles persistence.
5. **Session reuse** — if a conversation already exists for this plan, resume it instead of creating a new one. Fresh context on every open would waste tokens.

## UX Flow

1. User opens `/plans/[id]` → sees the plan editor
2. Clicks "Chat with Agent" (MessageSquare icon) → side panel opens
3. First time: picks an agent → session starts with plan context injected
4. Agent reads codebase, responds with suggestions
5. Agent outputs PLAN_EDIT block → diff card appears in chat
6. User clicks [Apply] → editor updates live, auto-saves
7. User types "what about error handling?" → agent responds with more suggestions
8. User clicks [Apply] on another suggestion → plan evolves
9. User closes panel → conversation persists (can reopen later)
10. User clicks "Execute" → the refined plan gets sent to an agent for implementation
