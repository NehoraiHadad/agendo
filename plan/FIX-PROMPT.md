# Agent Monitor Plan Fix — Team Prompt

Use a team of agents to fix all validated issues in the Agent Monitor plan files. The plan files are in `/home/ubuntu/projects/agent-monitor/plan/` and the reference docs are in `/home/ubuntu/projects/agent-monitor/planning/`.

## Context

Three validation reports identified issues across 7 plan files. The reports are:
- `plan/VALIDATION-cross-phase.md` — cross-phase consistency
- `plan/VALIDATION-architecture.md` — architecture principles alignment
- `plan/VALIDATION-data-model.md` — data model and protocol accuracy

**Important**: C-09 from the cross-phase report (claiming `execution.mode` doesn't exist) is a **false positive** — the column exists at `03-data-model.md:214`. Do NOT "fix" this.

## Reference Files (Source of Truth)

- `planning/02-architecture.md` — architecture spec
- `planning/03-data-model.md` — Drizzle ORM schema (THE authority for table/column/type names)
- `planning/04-phases.md` — master phase checklist
- `planning/01-brainstorm-synthesis.md` — confirmed decisions + P0 items

## Team Structure

Create a `plan-fix` team with 3 agents:

### Agent 1: `fix-phase-1-2-3` (general-purpose)
**Files**: `plan/phase-1-foundation.md`, `plan/phase-2-discovery.md`, `plan/phase-3-tasks.md`

**Fixes to apply:**

1. **Phase 1 — Add missing shadcn components** (W-02 through W-07):
   Update the shadcn install step to include ALL components used across all phases:
   ```
   npx shadcn@latest add button badge separator sheet scroll-area skeleton tooltip dialog select input textarea card toggle table command label
   ```

2. **Phase 1 — Add missing packages** (W-01, W-10, I-04):
   Add to the dependency install step: `sonner`, `date-fns`, `esbuild` (devDep)

3. **Phase 3 — Fix `.includes()` on Set** (C-05 / W-01):
   In `task-service.ts` `updateTask`, replace:
   ```typescript
   if (!allowed?.includes(input.status)) {
   ```
   With:
   ```typescript
   if (!isValidTaskTransition(existing.status, input.status)) {
   ```
   And add the import of `isValidTaskTransition` from `@/lib/constants`.

4. **Phase 3 — Fix typo** (I-01):
   `TaskSubtastsListProps` → `TaskSubtasksListProps`

### Agent 2: `fix-phase-4` (general-purpose)
**Files**: `plan/phase-4a-backend.md`, `plan/phase-4b-frontend.md`

**Fixes to apply:**

1. **Phase 4a — Add missing execution-service.ts + API routes** (C-06, the BIGGEST gap):
   Add new steps to Phase 4a for:
   - `src/lib/services/execution-service.ts` with functions: `createExecution`, `cancelExecution`, `getExecutionById`, `listExecutions`
   - API routes: `src/app/api/executions/route.ts` (GET list, POST create)
   - `src/app/api/executions/[id]/route.ts` (GET by id)
   - `src/app/api/executions/[id]/cancel/route.ts` (POST cancel)
   - `src/app/api/executions/[id]/message/route.ts` (POST send message)
   - **SSE log stream**: `src/app/api/executions/[id]/logs/stream/route.ts` — must use `fs.watch` for live log tailing (non-terminal executions only, per P0-4 scope guard)
   - Worker status route: `src/app/api/workers/status/route.ts`

   Reference `planning/04-phases.md:254-265` for the expected list of routes. Reference `planning/02-architecture.md` for the SSE/fs.watch pattern. The execution-service should follow the same patterns as agent-service and task-service from earlier phases.

2. **Phase 4a — Fix `config.ALLOWED_WORKING_DIRS` type mismatch** (C-07):
   In `safety.ts`, replace:
   ```typescript
   const allowedDirs = config.ALLOWED_WORKING_DIRS;
   ```
   With:
   ```typescript
   import { allowedWorkingDirs } from '@/lib/config';
   // ...
   const isAllowed = allowedWorkingDirs.some(
     (allowed) => resolved === allowed || resolved.startsWith(allowed + '/')
   );
   ```

3. **Phase 4a — Resolve JWT_SECRET naming** (C-08):
   Add `TERMINAL_JWT_SECRET: z.string().min(16).optional()` to Phase 1's config.ts Zod schema reference, OR document that the terminal server should reuse `JWT_SECRET`. Pick one approach and be consistent in both Phase 4a's terminal server code and the PM2 env config.

4. **Phase 4a — Fix `capability.workingDir`** (C-14):
   In `execution-runner.ts`, replace:
   ```typescript
   const resolvedCwd = validateWorkingDir(capability.workingDir);
   ```
   With:
   ```typescript
   const resolvedCwd = validateWorkingDir(agent.workingDir ?? '/tmp');
   ```
   Ensure the runner fetches the `agent` record (not just capability) before this line.

5. **Phase 4b — Remove phantom `execution_logs` table** (C-01):
   In the prerequisites table, remove `execution_logs`. The line should reference only `executions`.

6. **Phase 4b — Remove phantom `ExecutionLog` type** (C-02):
   In the prerequisites table, remove `ExecutionLog`. Log data comes from `Execution` type fields.

7. **Phase 4b — Fix `pending` status to `queued`** (C-03 / C-05 / W-05 / W-06):
   - In `STATUS_CONFIG`: remove `pending` entry, add `cancelling: { label: 'Cancelling', variant: 'secondary' }`
   - In `ExecutionCancelButton`: replace `status === 'pending'` with nothing (keep only `running` and `queued`)

8. **Phase 4b — Fix `Capability` type to `AgentCapability`** (C-04):
   In `execution-trigger-dialog.tsx`, change import from `Capability` to `AgentCapability`.

9. **Phase 4b — Fix capability field names** (C-13):
   In `execution-trigger-dialog.tsx`:
   - `cap.name` → `cap.label`
   - `cap.level` → `cap.dangerLevel`
   - `selectedCapability?.level` → `selectedCapability?.dangerLevel`

10. **Phase 4b — Remove `@types/dompurify`** (W-12):
    Remove from install list. `isomorphic-dompurify` ships its own types.

### Agent 3: `fix-phase-5-6` (general-purpose)
**Files**: `plan/phase-5-realtime.md`, `plan/phase-6-mcp-dashboard.md`, `planning/04-phases.md`

**Fixes to apply:**

1. **Phase 5 — Fix `workspaceId` inconsistency** (C-10):
   Since the app is personal-first (single workspace), remove the `workspaceId` filter from `reindexColumn` and the reorder route. The function should reindex all tasks in a given status column regardless of workspace. Add a comment: `// TODO: Add workspaceId filter when multi-workspace is implemented`.

2. **Phase 5 — Fix `await params`** (C-11 / W-02):
   In ALL Phase 5 route handlers, change:
   ```typescript
   async (req: NextRequest, { params }: { params: { id: string } }) => {
     const { id } = params;
   ```
   To:
   ```typescript
   async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
     const { id } = await params;
   ```

3. **Phase 5 — Fix `reindexColumn` signature mismatch** (C-16 / W-04):
   Align the function definition and call site. The function should import `db` and `tasks` internally (like other services), not accept them as parameters:
   ```typescript
   export async function reindexColumn(status: string): Promise<void> {
     // import db and schema internally
   ```
   Update all call sites accordingly.

4. **Phase 5 — Add `sonner` Toaster provider note**:
   Add a note that `<Toaster />` from `sonner` needs to be added to the root layout (or note that it was added in Phase 1 if the package is now there).

5. **Phase 6 — Fix MCP `assigneeAgentSlug` to UUID** (C-15):
   In the MCP server's `assign_task` and `create_task` handlers, add a slug-to-UUID resolution step:
   ```typescript
   // Resolve agent slug to UUID
   const agentRes = await fetch(`${API_BASE}/api/agents?slug=${assignee}`);
   const agents = await agentRes.json();
   if (agents.length === 0) throw new Error(`Agent not found: ${assignee}`);
   body.assigneeAgentId = agents[0].id;
   ```

6. **Phase 6 — Fix `workerConfig.value` jsonb cast** (W-11):
   Replace raw type assertion with proper parsing:
   ```typescript
   const maxDepth = Number(configMap.get('max_spawn_depth') ?? 3);
   ```

7. **04-phases.md — Fix port reference** (C-12):
   Correct the Phase 6 section to clarify that the MCP server uses stdio transport and calls the Next.js API at port 4100, not port 4000.

8. **04-phases.md — Fix file path references** (W-13, W-14):
   - `generic-adapter.ts` → `template-adapter.ts`
   - `src/terminal-server/index.ts` → `src/terminal/server.ts`

9. **Phase 5 — Deduplicate sort-order utils** (W-09):
   Add a note that sort-order utilities (`computeSortOrder`, `needsReindex`, `reindexColumn`) should be extracted to `src/lib/sort-order.ts` during Phase 3, and Phase 5 should import from there instead of redefining.

## Instructions for ALL agents

1. **Read the target file(s) fully** before making any edits
2. **Read `planning/03-data-model.md`** as the source of truth for all table/column/type names
3. **Make surgical edits** — only change what's specified, don't rewrite entire files
4. **After fixing**, update the relevant validation report to mark the issue as `FIXED` (add a line: `**Status**: FIXED — [brief description of what was changed]`)
5. **If a fix requires changes across phases** (e.g., Phase 1 package list affects Phase 4b), coordinate via messages — the agent owning the target file makes the edit
6. After all fixes are done, each agent should message the team lead confirming what was fixed and listing any issues they couldn't resolve

## Verification

After all agents finish, send a final agent to:
1. Grep for `execution_logs` across all plan files (should find zero matches except in validation reports)
2. Grep for `pending` in execution status contexts (should find zero outside validation reports)
3. Grep for `cap.name` and `cap.level` (should find zero outside validation reports)
4. Grep for `Capability` type imports that aren't `AgentCapability` (should find zero)
5. Grep for `config.ALLOWED_WORKING_DIRS` in Phase 4a (should find zero — replaced with `allowedWorkingDirs`)
6. Confirm `execution-service.ts` steps exist in Phase 4a
7. Confirm all Phase 5 routes use `await params`
