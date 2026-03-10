# Task: Fix GET /api/integrations to show only active integrations

## Problem

`GET /api/integrations` currently returns ALL tasks in the system project that have `integrationName` in their inputContext. This includes:

- Removal tasks ("Remove integration: X") — these are operational, not integrations
- Subtasks (implementer tasks) — these are children, not top-level
- Completed removal tasks — the integration no longer exists but the old planner task still shows

## Current code

File: `src/app/api/integrations/route.ts` (the GET handler around line 52)

```typescript
const integrationTasks = await db
  .select()
  .from(tasks)
  .where(
    and(
      eq(tasks.projectId, systemProject.id),
      sql`${tasks.inputContext}->'args'->>'integrationName' IS NOT NULL`,
    ),
  )
  .orderBy(sql`${tasks.createdAt} DESC`);
```

## What it should do

Show only **planner tasks** (top-level integrations), and indicate whether each one is currently active (has a registered MCP server / capability) or was removed.

### Approach 1 (minimal — recommended):

Filter to only top-level planner tasks:

- `parentTaskId IS NULL` — excludes subtasks (implementer)
- `title LIKE 'Integrate:%'` — excludes removal tasks

### Approach 2 (richer):

Same filter as Approach 1, but also join/check if a corresponding removal task exists and completed. Add an `isActive` computed field so the UI can show removed integrations as greyed out or hidden.

## UI file

`src/app/(dashboard)/integrations/integrations-client.tsx` — renders the list. Currently shows all tasks as cards. After the fix, it should only show planner-level integrations. Consider adding a visual indicator for removed vs active.

## Testing

After the fix:

```bash
curl -s http://localhost:4100/api/integrations | jq '[.data[] | {title, status}]'
```

Should show only planner tasks like `"Integrate: memory"`, NOT removal tasks.

## Cleanup

There are leftover test tasks from E2E testing. After fixing the query, clean them up:

```bash
# These are the test tasks — delete if they still exist:
# 753e4417 — "Integrate: memory" (planner, done)
# d3585510 — "Remove integration: memory" (remover, done)
# e8bffd48 — subtask of 753e4417 (implementer, done)
```
