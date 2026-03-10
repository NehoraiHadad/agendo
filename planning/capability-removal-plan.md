# Capability Removal — Implementation Plan

**Goal:** מחיקה מלאה של `AgentCapability` — DB, API, services, UI, worker.
**Scope:** ~30 קבצים לשינוי, 8 קבצים למחיקה, migration אחד.

---

## שלב 0 — Migration

### קובץ חדש: `drizzle/XXXX_drop_capabilities.sql`

```sql
-- 1. הסר FK מ-sessions
ALTER TABLE sessions DROP COLUMN capability_id;

-- 2. הסר את הטבלה
DROP TABLE agent_capabilities;

-- 3. הסר את ה-enums
DROP TYPE capability_source;
DROP TYPE interaction_mode;
```

### עדכן `src/lib/db/schema.ts`:

- מחק את `agentCapabilities` table definition
- מחק את `capabilitySourceEnum`
- מחק את `interactionModeEnum`
- מחק שדה `capabilityId` מ-`sessions` table

---

## שלב 1 — מחק קבצים (8)

```
src/lib/services/capability-service.ts
src/lib/services/__tests__/capability-service.test.ts
src/lib/actions/capability-actions.ts
src/components/agents/capability-list.tsx
src/components/agents/capability-row.tsx
src/components/agents/add-capability-dialog.tsx
src/app/api/agents/[id]/capabilities/route.ts
src/app/api/agents/[id]/capabilities/[capId]/route.ts
```

---

## שלב 2 — Worker

### `src/lib/worker/session-runner.ts`

- **הסר:** `import { getCapabilityById }` + קריאה ל-`getCapabilityById(session.capabilityId)`
- **הסר:** כל הבלוק של `capability.promptTemplate` + `interpolatePrompt`
- **הסר:** פונקציה `interpolatePrompt` (אם מוגדרת כאן)
- **הוסף:** fallback פשוט ישירות:
  ```typescript
  // במקום capability.promptTemplate:
  if (!prompt && task) {
    prompt = [task.title, task.description].filter(Boolean).join('\n\n');
  }
  ```

---

## שלב 3 — Services

### `src/lib/types.ts`

- מחק: `AgentCapability`, `NewCapability`, `InteractionMode`, `CapabilitySource`
- מחק: `AgentWithCapabilities` (אם הוגדר כאן)

### `src/lib/services/session-service.ts`

- **`CreateSessionInput`:** הסר שדה `capabilityId: string`
- **`createSession()`:** הסר `capabilityId` מה-`.values({...})`
- **`getSessionWithDetails()`:** הסר `.leftJoin(agentCapabilities, ...)` + הסר `capLabel` מה-select ומה-return type
- **`forkSession()`:** הסר `capabilityId: parent.capabilityId` מה-insert
- **Import:** הסר את `agentCapabilities` מה-import של schema

### `src/lib/services/session-fork-service.ts`

- **`ForkToAgentInput`:** הסר שדה `capabilityId?: string`
- **הסר לגמרי:** שלב 4 בפונקציה — כל הבלוק של capability resolution (~35 שורות)
- **`createSession()`:** הסר `capabilityId` מהקריאה
- **Import:** הסר `agentCapabilities` מה-imports

### `src/lib/services/plan-service.ts`

- **`StartPlanConversationOpts`:** הסר `capabilityId: string`
- **`ExecutePlanOpts`:** הסר `capabilityId: string`
- **`ValidatePlanOpts`:** הסר `capabilityId: string`
- **וגם interface שמשתמשים ב-breakdown:** הסר `capabilityId`
- **כל קריאות ל-`createAndEnqueueSession()`:** הסר `capabilityId: opts.capabilityId`

### `src/lib/services/snapshot-service.ts`

- **Interface opts:** הסר `capabilityId: string`
- **קריאה ל-`createAndEnqueueSession()`:** הסר `capabilityId`

### `src/lib/services/agent-service.ts`

- **`createFromDiscovery()`:** הסר את כל הבלוק:
  ```typescript
  // מחק את כל זה:
  if (preset?.defaultCapabilities.length) {
    for (const cap of preset.defaultCapabilities) {
      await db.insert(agentCapabilities).values({...});
    }
  }
  ```
- **`listAgentsWithCapabilities()`:** מחק את הפונקציה כולה
- **`AgentWithCapabilities` type:** מחק
- **Import:** הסר `agentCapabilities` ו-`AgentCapability`

### `src/lib/services/session-helpers.ts` (אם קיים)

- הסר `capabilityId` מ-`CreateAndEnqueueSessionInput` ומהקריאה ל-`createSession()`

---

## שלב 4 — API Routes

### `src/app/api/sessions/route.ts`

- **Schema:** הסר `capabilityId: z.string().uuid()`
- **הסר:** `import { assertPromptModeCapability }`
- **הסר:** `await assertPromptModeCapability(body.capabilityId)`
- **`createSession()`:** הסר `capabilityId: body.capabilityId`

### `src/app/api/sessions/[id]/fork-to-agent/route.ts`

- **Schema:** הסר `capabilityId: z.string().uuid().optional()`
- **קריאה ל-`forkSessionToAgent()`:** הסר `capabilityId: body.capabilityId`

### `src/app/api/integrations/route.ts` (POST)

- **הסר:** כל הבלוק של capability lookup (שורות 85-104)
- **החלף** ב:

  ```typescript
  // Find first active AI agent (or use requestedAgentId directly)
  const agentRow = requestedAgentId
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, requestedAgentId), eq(agents.isActive, true)))
        .limit(1)
    : await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.isActive, true), eq(agents.toolType, 'ai-agent')))
        .limit(1);

  if (!agentRow.length) throw new NotFoundError('Agent', 'active ai-agent');
  const agentId = agentRow[0].id;
  ```

- **`createAndEnqueueSession()`:** הסר `capabilityId`
- **Import:** הסר `agentCapabilities`

### `src/app/api/integrations/[name]/route.ts` (DELETE)

- **הסר:** כל הבלוק של `repo-remover` capability lookup (שורות 43-58)
- **החלף** ב:

  ```typescript
  // Reuse the same agent that ran the original task
  const agentId =
    originalTask.assigneeAgentId ??
    (
      await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.isActive, true), eq(agents.toolType, 'ai-agent')))
        .limit(1)
    )[0]?.id;

  if (!agentId) throw new NotFoundError('Agent', 'active ai-agent');
  ```

- **`createAndEnqueueSession()`:** הסר `capabilityId`
- **Import:** הסר `agentCapabilities`

### `src/app/api/plans/[id]/conversation/route.ts`

- **Schema:** הסר `capabilityId: z.string().uuid()`
- **קריאה:** הסר `capabilityId` מהפרמטרים

### `src/app/api/plans/[id]/execute/route.ts`

- **Schema:** הסר `capabilityId: z.string().uuid()`
- **קריאה:** הסר `capabilityId`

### `src/app/api/plans/[id]/validate/route.ts`

- **Schema:** הסר `capabilityId: z.string().uuid()`
- **קריאה:** הסר `capabilityId`

### `src/app/api/plans/[id]/breakdown/route.ts`

- **Schema:** הסר `capabilityId: z.string().uuid()`
- **קריאה:** הסר `capabilityId`

### `src/app/api/snapshots/[id]/resume/route.ts`

- **Schema:** הסר `capabilityId: z.string().uuid()`
- **קריאה:** הסר `capabilityId`

### `src/app/api/projects/[id]/sessions/route.ts`

- **הסר:** capability lookup query (~10 שורות)
- **`createSession()`:** הסר `capabilityId: cap.id`

### `src/app/api/config/analyze/ai-session/route.ts`

- **הסר:** capability lookup query (~10 שורות)
- **`createSession()`:** הסר `capabilityId: cap.id`

### `src/app/api/sessions/import/route.ts`

- **הסר:** capability lookup query (~10 שורות)
- **`createSession()`:** הסר `capabilityId: capability.id`

### `src/app/api/agents/route.ts`

- **הסר:** `?capabilities=true` branch + `listAgentsWithCapabilities()` call
- כשמגיע `?capabilities=true` → פשוט קרא ל-`listAgents()` (capabilities field יהיה נעדר — clients צריך לעדכן)

---

## שלב 5 — MCP Server

### `src/lib/mcp/tools/session-tools.ts`

- **`handleStartAgentSession()`:** הסר את שלב 2 (capability lookup):
  ```typescript
  // מחק:
  const capabilities = await apiCall(`/api/agents/${agentId}/capabilities`);
  const promptCap = capabilities.find(c => c.interactionMode === 'prompt');
  if (!promptCap) throw new Error(...);
  ```
- **קריאה ל-`/api/sessions`:** הסר `capabilityId: promptCap.id`

---

## שלב 6 — UI Components

### `src/components/integrations/connect-repo-dialog.tsx`

- **הסר:** `AgentWithCapabilities` interface (השתמש ב-`Agent` פשוט)
- **שנה fetch:** מ-`/api/agents?capabilities=true` ל-`/api/agents?group=ai`
- **הסר:** `const hasCap = agent.capabilities.some(...)` filter
- **שמור:** לולאה שמציגה כל active agent (`if (!agent.isActive) continue` בלבד)

### `src/components/settings/agent-cards.tsx`

- **הסר:** `const capCount = agent.capabilities.length`
- **הסר:** ה-badge שמציג מספר capabilities

### `src/app/(dashboard)/agents/[id]/page.tsx`

- **הסר:** `await getCapabilitiesByAgent(id)` import וקריאה
- **הסר:** `<CapabilityList .../>` component מה-render
- **הסר:** import של `CapabilityList`

### `src/app/(dashboard)/sessions/[id]/session-detail-client.tsx`

- **הסר:** `capLabel` מ-`SessionWithDetails` usage (הוא לא יחזור מה-API)
- **הסר:** `capabilityId` מ-state שמועבר ל-`AgentSwitchDialog`

### `src/components/sessions/agent-switch-dialog.tsx`

- **הסר:** `capabilityId: string` מה-interface
- **הסר:** העברת `capabilityId` ל-API call

### `src/components/sessions/start-session-dialog.tsx`

- **הסר:** `promptCapId` state
- **הסר:** `fetchCapabilities()` פונקציה
- **הסר:** `useEffect` שקורא ל-`fetchCapabilities`
- **`handleSubmit()`:** הסר `capabilityId: promptCapId` מה-body

---

## שלב 7 — Discovery/Presets

### `src/lib/discovery/presets.ts`

- **הסר:** `PresetCapability` interface
- **הסר:** `defaultCapabilities` שדה מ-`AIToolPreset` interface
- **הסר:** כל `defaultCapabilities: [...]` arrays מ-3 הפרסטים

---

## סיכום מה שנשמר / לא קיים יותר

| מה                          | לפני                      | אחרי                               |
| --------------------------- | ------------------------- | ---------------------------------- |
| sessions.capabilityId       | NOT NULL FK               | לא קיים                            |
| agent_capabilities table    | 12-15 שורות               | לא קיים                            |
| assertPromptModeCapability  | נקרא בכל session creation | לא קיים                            |
| promptTemplate              | DB column, interpolation  | לא קיים                            |
| Integration agent discovery | לפי `key='repo-planner'`  | לפי `agentId` מפורש / first active |
| repo-planner filter בדיאלוג | מסנן לפי capability       | מציג כל active agent               |
| capLabel בsession detail    | מוצג                      | לא מוצג                            |
| CRUD UI (3 components)      | קיים בtab agents          | לא קיים                            |

## סדר ביצוע מומלץ

1. **Migration** → הסרת הטבלה והעמודה
2. **schema.ts** → עדכון ה-schema
3. **types.ts** → הסרת types
4. **capability-service.ts** → מחיקה
5. **session-service.ts** → הסרת capabilityId מ-CreateSessionInput (כל השרשרת נשברת כאן → עוקבים אחרי שגיאות TypeScript)
6. **session-runner.ts** → הסרת capability fetch + inline fallback
7. **כל ה-API routes** → לפי שגיאות TypeScript
8. **session-tools.ts (MCP)** → הסרת capability lookup
9. **UI components** → הסרת capability fetching
10. **presets.ts + agent-service.ts** → ניקוי discovery
11. **מחיקת 8 קבצים**
12. `pnpm typecheck` → לוודא אפס שגיאות
