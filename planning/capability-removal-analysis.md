# Capability Abstraction — Removal Analysis

**Date:** 2026-03-10
**Status:** Analysis complete, awaiting implementation decision
**Task:** f5c91c7d-6ac1-4a38-8461-72e91678e501

---

## The Abstraction

`AgentCapability` is a row in `agent_capabilities` table. Every session stores a `capabilityId` FK (NOT NULL). Fields:

| Field              | Type                   | Used?                                    |
| ------------------ | ---------------------- | ---------------------------------------- |
| `id`               | UUID PK                | Yes (FK in sessions)                     |
| `agentId`          | UUID FK → agents       | Yes                                      |
| `key`              | text                   | **Yes** — integration pipeline discovery |
| `label`            | text                   | Yes — displayed in session details       |
| `description`      | text                   | No                                       |
| `source`           | enum                   | No (at runtime)                          |
| `interactionMode`  | enum (only `'prompt'`) | **Vacuous** — always passes              |
| `promptTemplate`   | text                   | **Rarely** — only when no initialPrompt  |
| `requiresApproval` | boolean                | No                                       |
| `isEnabled`        | boolean                | Yes — filters in queries                 |
| `dangerLevel`      | smallint               | No                                       |
| `timeoutSec`       | integer                | No                                       |
| `maxOutputBytes`   | integer                | No                                       |

---

## Usage Map — All 46 Files

### 1. DB Schema (`src/lib/db/schema.ts`)

- `agentCapabilities` table definition
- `capabilitySourceEnum` (9 values, only 'builtin'/'preset'/'manual' used)
- `interactionModeEnum` (single value: `'prompt'`)
- `sessions.capabilityId` — required NOT NULL FK

### 2. Worker: `session-runner.ts`

```typescript
const capability = await getCapabilityById(session.capabilityId);
// ...
if (!prompt && capability.promptTemplate) {
  prompt = interpolatePrompt(capability.promptTemplate, { task_title, task_description, ... });
}
```

**Value:** `promptTemplate` as default when no `initialPrompt`. In practice, most sessions get an `initialPrompt` either from the user or from task title/description prepended by `startSessionDialog`. The template fires only for headless task sessions without an explicit prompt.

### 3. Session API: `POST /api/sessions`

- Requires `capabilityId` UUID
- Calls `assertPromptModeCapability(capabilityId)` — checks `interactionMode === 'prompt'`
- **Value:** Zero — `interactionMode` only has one value, check always passes

### 4. Integration Pipeline

**`POST /api/integrations`:**

```sql
SELECT agentId, capabilityId FROM agent_capabilities
WHERE key='repo-planner' AND isEnabled=true AND agents.isActive=true
```

**`DELETE /api/integrations/[name]`:**

```sql
SELECT agentId, capabilityId FROM agent_capabilities
WHERE key='repo-remover' AND isEnabled=true AND agents.isActive=true
```

**Value: THIS IS THE ONLY REAL VALUE.** Capabilities let you tag an agent with a role (`repo-planner`, `repo-remover`) and then look up that agent by role. Without this, you need another mechanism to answer "which agent should plan integrations?"

### 5. MCP Tool: `start_agent_session` (`session-tools.ts`)

```typescript
const capabilities = await apiCall(`/api/agents/${agentId}/capabilities`);
const promptCap = capabilities.find((c) => c.interactionMode === 'prompt');
// always finds one — interactionMode is always 'prompt'
```

**Value:** Zero — just finds "the first capability" which is always the only one.

### 6. Session Fork Service (`session-fork-service.ts`)

```typescript
// Falls back to first enabled prompt cap when no explicit capabilityId
const [fallbackCap] = await db.select({ id })
  .from(agentCapabilities)
  .where(isEnabled=true AND interactionMode='prompt')
  .limit(1);
capabilityId = fallbackCap.id;
```

**Value:** Zero — always finds "the first capability".

### 7. Plan Service (`plan-service.ts`)

- `capabilityId` passed through to `createAndEnqueueSession` in 4 places
- **Value:** Pure pass-through, no logic on capability itself

### 8. Start Session Dialog (`start-session-dialog.tsx`)

```typescript
const promptCaps = res.data.filter((c) => c.isEnabled && c.interactionMode === 'prompt');
if (promptCaps.length > 0) setPromptCapId(promptCaps[0].id);
```

The user **never** sees or chooses a capability in the UI. The dialog silently picks the first one.
**Value:** Zero — user-invisible auto-select.

### 9. `getSessionWithDetails` (session-service)

```typescript
.leftJoin(agentCapabilities, eq(sessions.capabilityId, agentCapabilities.id))
// → capLabel: agentCapabilities.label
```

**Value:** `capLabel` shown in session detail. Would need to be replaced with something (agent name already available).

### 10. CRUD API + UI

- `GET/POST /api/agents/[id]/capabilities`
- `PATCH/DELETE /api/agents/[id]/capabilities/[capId]`
- `capability-list.tsx`, `capability-row.tsx`, `add-capability-dialog.tsx`
- **Value:** Admin management of capabilities. If capabilities are removed, these go away.

### 11. Presets (`src/lib/discovery/presets.ts`)

Each agent preset defines `defaultCapabilities` (4 caps: prompt, code-review, implement-feature, fix-bug). These are seeded into the DB on first agent discovery.
**Value:** The `promptTemplate` per capability gives task-type-specific default prompts. But the UI never lets you choose which template to use — it always picks the first (`prompt`).

### 12. Other References

- `src/app/api/projects/[id]/sessions/route.ts` — capability lookup for project-scoped sessions
- `src/app/api/config/analyze/ai-session/route.ts` — capability lookup for config analysis
- `src/app/api/sessions/import/route.ts` — capability lookup for imported sessions
- `src/lib/services/snapshot-service.ts` — capabilityId in opts
- All these are pass-throughs that find the first prompt-mode capability

---

## Analysis Summary

### What capability actually does:

1. **Provides a DB hook for sessions** — `capabilityId NOT NULL` in `sessions` table
2. **Tags agents with roles** (key=`repo-planner`, `repo-remover`) for integration pipeline discovery
3. **Provides a default promptTemplate** when no initialPrompt is given (rarely triggered)
4. **Provides a label** shown in session detail view

### What capability does NOT do (but looks like it does):

- **Does NOT let users pick between capabilities** — UI auto-picks the first one
- **Does NOT gate behavior on interactionMode** — enum only has one value
- **Does NOT use most of its fields** (requiresApproval, dangerLevel, timeoutSec, maxOutputBytes, description, source — all dead at runtime)
- **Does NOT gate templates in practice** — initialPrompt is always set before the template fires

### Why it's over-engineered:

The original vision was execution-mode vs prompt-mode capabilities (hence `interactionMode`), with each capability having CLI args, timeout, approval requirements, etc. That vision was abandoned when executions were removed, leaving only prompt-mode. What remains is a 13-column table that functions as a 2-column tag table (`agentId`, `key`).

---

## Proposal: Full Removal

### Replacement for role-based agent discovery

Add a `roles: text[]` column to the `agents` table:

```sql
ALTER TABLE agents ADD COLUMN roles jsonb NOT NULL DEFAULT '[]'::jsonb;
-- seed: UPDATE agents SET roles='["repo-planner"]' WHERE slug='claude-code-1'
```

Integration pipeline becomes:

```sql
SELECT id FROM agents WHERE 'repo-planner' = ANY(roles::text[]) AND is_active=true LIMIT 1
```

### Replacement for promptTemplate

Since `start-session-dialog` already prefills the prompt from `task.title + task.description`, and `session-runner` only uses `promptTemplate` when `initialPrompt` is absent, we can:

- Either always require `initialPrompt` (break for headless task sessions without prompt)
- Or add a simple default: if no prompt and task exists, build `"${task.title}\n\n${task.description}"` directly in session-runner without a template
- The per-capability template variants (`code-review`, `implement-feature`, `fix-bug`) are never chosen — they can be dropped

The minimal in-runner fallback:

```typescript
if (!prompt && task) {
  prompt = [task.title, task.description].filter(Boolean).join('\n\n');
}
```

### Replacement for capLabel

`getSessionWithDetails` currently returns `capLabel`. Replace with nothing (or use `agentName` which is already returned). Session detail doesn't need to show the capability name.

---

## Implementation Record

### Files to DELETE

```
src/lib/services/capability-service.ts
src/lib/actions/capability-actions.ts
src/lib/services/__tests__/capability-service.test.ts
src/components/agents/capability-list.tsx
src/components/agents/capability-row.tsx
src/components/agents/add-capability-dialog.tsx
src/app/api/agents/[id]/capabilities/route.ts
src/app/api/agents/[id]/capabilities/[capId]/route.ts
```

### DB Changes

1. `src/lib/db/schema.ts`:
   - Remove `agentCapabilities` table
   - Remove `capabilitySourceEnum`
   - Remove `interactionModeEnum`
   - Remove `capabilityId` column from `sessions`
   - Add `roles: jsonb` column to `agents`

2. New migration:
   - `ALTER TABLE sessions DROP COLUMN capability_id`
   - `DROP TABLE agent_capabilities`
   - `DROP TYPE capability_source`
   - `DROP TYPE interaction_mode`
   - `ALTER TABLE agents ADD COLUMN roles jsonb NOT NULL DEFAULT '[]'::jsonb`
   - Seed: `UPDATE agents SET roles='["repo-planner","repo-implementer"]'::jsonb WHERE slug='claude-code-1'`

### Files to MODIFY (remove capabilityId references)

#### Core services

- `src/lib/services/session-service.ts` — remove `capabilityId` from `CreateSessionInput`, remove `agentCapabilities` join
- `src/lib/services/session-fork-service.ts` — remove capability resolution (steps 4), just use `agentId` directly
- `src/lib/services/plan-service.ts` — remove `capabilityId` from all opts interfaces
- `src/lib/services/snapshot-service.ts` — remove `capabilityId` from opts
- `src/lib/services/agent-service.ts` — remove capability creation in discovery/seeding
- `src/lib/types.ts` — remove `AgentCapability`, `NewCapability`, `InteractionMode`, `CapabilitySource`

#### Worker

- `src/lib/worker/session-runner.ts` — remove `getCapabilityById`, replace promptTemplate with inline fallback

#### API routes (remove capabilityId)

- `src/app/api/sessions/route.ts`
- `src/app/api/sessions/[id]/fork-to-agent/route.ts`
- `src/app/api/integrations/route.ts` — replace cap key lookup with `roles` query
- `src/app/api/integrations/[name]/route.ts` — same
- `src/app/api/plans/[id]/conversation/route.ts`
- `src/app/api/plans/[id]/execute/route.ts`
- `src/app/api/plans/[id]/validate/route.ts`
- `src/app/api/plans/[id]/breakdown/route.ts`
- `src/app/api/snapshots/[id]/resume/route.ts`
- `src/app/api/projects/[id]/sessions/route.ts`
- `src/app/api/config/analyze/ai-session/route.ts`
- `src/app/api/sessions/import/route.ts`

#### MCP

- `src/lib/mcp/tools/session-tools.ts` — remove capability lookup, just pass agentId directly to session API

#### UI components

- `src/components/sessions/start-session-dialog.tsx` — remove capability fetch, remove `promptCapId` state
- `src/components/sessions/agent-switch-dialog.tsx` — remove capability picker if present
- `src/components/agents/agent-row.tsx` — remove capability count display
- `src/app/(dashboard)/agents/[id]/page.tsx` — remove CapabilityList section
- `src/components/settings/agent-cards.tsx` — remove capability display
- `src/app/(dashboard)/sessions/[id]/session-detail-client.tsx` — remove `capLabel` display

#### Discovery

- `src/lib/discovery/presets.ts` — remove `defaultCapabilities` from presets, add `roles` array
- `src/lib/services/agent-service.ts` — seed `roles` from preset instead of capabilities

---

## Risk Assessment

**Low risk:**

- `interactionMode` checks can be deleted without behavioral change (always passed)
- `assertPromptModeCapability` can be deleted without behavioral change (always passed)
- Capability CRUD UI — not visible in main workflows

**Medium risk:**

- `promptTemplate` fallback — only matters for headless sessions without `initialPrompt`. After removal, inline fallback must cover the same cases.
- `capLabel` in session details — minor display regression (show nothing instead)
- `roles`-based agent discovery — integration pipeline becomes simpler but requires correct seeds

**High risk (requires care):**

- DB migration on `sessions.capabilityId` NOT NULL — existing data has capabilityId. Migration must:
  1. Drop the FK constraint first
  2. Drop the column
  3. Not break existing session rows

**Estimated scope:** ~2-3 hours of mechanical changes across ~30 files + 1 migration.

---

## Recommendation

**Full removal.** The capability abstraction adds no value in the current system. The only real function (role-based agent discovery for integrations) can be replaced by a `roles: text[]` field on `agents`. The CRUD machinery (8 files, 13-column table, full REST API, 3 UI components) is dead weight. Removing it simplifies every session creation path and removes an unnecessary required FK from `sessions`.
