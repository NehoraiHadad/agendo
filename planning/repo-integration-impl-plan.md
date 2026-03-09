# Repo Integration — Implementation Plan

> Author: Claude | Date: 2026-03-09 | Status: **Ready for tasking**
>
> Detailed plan covering all 6 design areas. Grounded in actual codebase state.

---

## Confirmed Codebase Facts (pre-checked)

Before any design decisions, the following were verified against actual source files:

| Question                                                 | Answer                                                                            | Source                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| Does `POST /api/agent-capabilities` exist?               | **No** — it's `/api/agents/:id/capabilities`                                      | `src/app/api/agents/[id]/capabilities/route.ts`   |
| Does `POST /api/mcp-servers` exist?                      | **Yes**                                                                           | `src/app/api/mcp-servers/route.ts`                |
| Does `POST /api/tasks` accept `inputContext`?            | **No** (route schema omits it)                                                    | `src/app/api/tasks/route.ts` + task-service.ts:26 |
| Does `createTask` service accept `inputContext`?         | **Yes**                                                                           | `src/lib/services/task-service.ts:26,183`         |
| Does `save_plan` MCP tool exist?                         | **Yes** → calls `POST /api/plans/mcp-save`                                        | `src/app/api/plans/mcp-save/route.ts`             |
| Does `POST /api/plans/:id/execute` exist?                | **Yes** — takes `agentId`, `capabilityId`, `model`                                | `src/app/api/plans/[id]/execute/route.ts`         |
| Does `{{input_context.args.repoUrl}}` work in templates? | **Yes** — `interpolatePrompt` walks dot paths                                     | `src/lib/worker/session-runner.ts:53-64`          |
| What is `TaskInputContext`?                              | `{ workingDir?, envOverrides?, args?: Record<string,unknown>, promptAdditions? }` | `src/lib/types.ts:63-68`                          |
| What permission mode should planner use?                 | `plan` (read-only) — confirmed correct for analysis-only                          | `sessions` table schema, claude-adapter.ts        |
| Where does the UI live?                                  | `(dashboard)` route group, project hub at `/projects/:id`                         | `src/app/(dashboard)/projects/[id]/page.tsx`      |

---

## Area 1: The Planner Prompt — Exact Design

### What the agent reads, in order

The planner works in `permissionMode: 'plan'` (read-only — cannot write files or run bash commands
that modify state). This is enforced by the Claude adapter passing `--approval-mode plan`.

**Reading sequence:**

1. `get_my_task` — get task title, description, inputContext (has repoUrl, branch, docsUrl)
2. `Read /home/ubuntu/projects/agendo/CLAUDE.md` — patterns and constraints
3. `Read /home/ubuntu/projects/agendo/planning/03-data-model.md` — authoritative data model
4. `WebFetch <repoUrl>` — GitHub repo page (README preview, description)
5. `WebFetch <repoUrl>/blob/main/llms.txt` — if 200, read this FIRST as authoritative LLM summary
6. `WebFetch <repoUrl>/blob/main/README.md` — primary human docs
7. `WebFetch <repoUrl>/blob/main/package.json` — JS dependency detection
8. WebSearch `"<repoName> MCP server"` or `"<repoName> Claude skill"` — quick context check

> **Why WebFetch not git clone?** The planner runs in `plan` mode (read-only). It cannot run bash.
> WebFetch is sufficient to read README, package.json, llms.txt from GitHub raw URLs.
> The implementer (not the planner) does the actual clone.

### How it handles llms.txt

`llms.txt` is an emerging convention (like `robots.txt`) where repo maintainers provide an
LLM-optimized summary. If it exists:

- Read it **before** README — it is more precise for LLM consumption
- Trust it as the authoritative description of what the repo does
- README may have marketing language; llms.txt has structured facts

If absent: use README + package.json as primary inputs.

### Plan output format (save_plan content)

The plan is structured Markdown with required sections. The planner calls `save_plan` with this
exact format:

````markdown
# Integration Plan: <repo-name>

## Overview

- **Repo**: <url>
- **Type**: capability | mcp_server | ui_feature | mixed
- **Summary**: <1-2 sentences: what this tool does>

## Integration Strategy

<3-5 sentences: what will be built inside Agendo and why this approach>

## What the Implementer Needs to Do

### 1. Clone and prepare

```bash
git clone --depth=1 <repoUrl> /data/agendo/repos/<repo-name>
cd /data/agendo/repos/<repo-name>
# IF mcp_server: npm install && npm run build
```
````

### 2. Files to create

- `src/integrations/<repo-name>/manifest.json` (always required)
- <any other files — e.g. UI pages only for ui_feature type>

### 3. API registrations

#### For capability type:

```bash
# Get Claude agent ID first:
AGENT_ID=$(curl -s http://localhost:4100/api/agents | jq -r '.data[] | select(.slug=="claude-code-1") | .id')

curl -s -X POST "http://localhost:4100/api/agents/$AGENT_ID/capabilities" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "<kebab-case-key>",
    "label": "<Human Label>",
    "description": "<1 sentence>",
    "promptTemplate": "<FULL SKILL PROMPT FROM REPO HERE>"
  }'
```

#### For mcp_server type:

```bash
curl -s -X POST http://localhost:4100/api/mcp-servers \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<name>",
    "transportType": "stdio",
    "command": "node",
    "args": ["/data/agendo/repos/<repo-name>/dist/index.js"],
    "enabled": true,
    "isDefault": false
  }'
```

### 4. Validation

```bash
cd /home/ubuntu/projects/agendo
pnpm typecheck && pnpm lint
```

### 5. Commit

```bash
git add src/integrations/<repo-name>/
git commit -m "feat(integration): add <repo-name> from <repoUrl>

Generated by Agendo repo integrator.
Source: <repoUrl>
Task: <taskId>"
```

## Subtasks Created

- (list the subtasks created, in execution order)

## Ambiguities / Risks

- <anything the implementer should be aware of>

```

### Type classification rules

| Type | Detection signals |
|------|-------------------|
| `capability` | `CLAUDE.md` with prompts in repo root or `skills/` dir; prompt text referencing Claude behaviors |
| `mcp_server` | `@modelcontextprotocol/sdk` in `dependencies` or `devDependencies`; `"tools"` array in source; stdio server pattern |
| `ui_feature` | React components + Next.js pages; `next` in dependencies; no MCP dependency |
| `mixed` | Any combination, e.g. MCP server that also ships a Claude skill prompt |

When type is ambiguous: classify as `mixed`, explain both paths in the plan, note which is more
likely, and let the user decide at the approval checkpoint.

### Subtask creation rules

The planner creates subtasks using `create_subtask`. Required subtask is always:

- `"Implement: <repo-name> integration"` — the implementer's work, always last

Optional validation subtasks (created BEFORE implement, in order):

| Condition | Subtask to create |
|-----------|-------------------|
| `mcp_server` type | `"Validate build: <repo-name>"` |
| Complex/unfamiliar repo | `"Security review: <repo-name>"` |
| Large UI feature | `"Compatibility check: <repo-name>"` |

Set `executionOrder` on subtasks: validation=1, security=2, implement=last.

### Stopping rules (exact)

After calling `save_plan` and `create_subtask` (for each step):

1. Call `update_task` to mark the planning task as `done`
2. **STOP** — do not write any code, do not modify any files, do not run bash

The planner's session ends naturally. The plan appears in the Plans UI linked to the project.
The "Implement" subtask is now `todo` and visible on the Kanban board.

### Ambiguous repo handling

If the repo has no clear integration point (generic library, non-tool code, academic paper):

1. Classify as `mixed`
2. Write in the plan: what COULD be done (even if just a capability prompt wrapping the README)
3. List the uncertainties explicitly under "Ambiguities / Risks"
4. Still create the "Implement" subtask — the implementer can handle ambiguity with more context
5. Note in the plan: "This integration requires user review before execution"

---

## Area 2: The Implementer Prompt — Exact Design

### How it receives the plan

The implementer capability is started via `POST /api/plans/:id/execute` (which calls `executePlan`
in plan-service.ts). The `initialPrompt` passed to the session is the plan content itself — the
full markdown from `plan.content`.

The implementer does NOT re-read or re-analyze the repo. It receives the plan as its brief and
executes it faithfully, validating at each step.

### The promptTemplate for the implementer capability

```

You are the Agendo Repo Integration Implementer. You will execute a pre-approved integration plan.

## Your task

{{task_title}}

## The approved plan

{{input_context.args.planContent}}

## Working directory

/home/ubuntu/projects/agendo

## Rules

### Read before you write

Before writing each file, read an existing file of the same type first:

- New API route → read `src/app/api/tasks/route.ts`
- New service function → read `src/lib/services/task-service.ts`
- New page → read `src/app/(dashboard)/projects/[id]/page.tsx`
- New component → read `src/components/projects/project-hub-client.tsx`

### Validate as you go

After each file written:

```bash
pnpm typecheck 2>&1 | head -30
```

Fix errors before moving to the next file. Do NOT write all files then validate.

### Fix iterations

If typecheck/lint fails: fix and retry. Maximum **3 iterations** per file.
If still failing after 3 iterations: stop, add a progress note explaining the specific error,
create a subtask "Fix: <error description>", and continue with other files if possible.

### Never guess agent IDs

Always query the API to get current IDs:

```bash
curl -s http://localhost:4100/api/agents | jq '.data[] | {id, slug}'
```

## Steps to execute (in order)

1. Re-read the plan above carefully
2. Clone the repo and run any build steps specified
3. Follow each "Files to create" step (read-before-write, validate-after-write)
4. Make each API registration call specified in the plan
5. Create the manifest file at `src/integrations/<name>/manifest.json`
6. Run final validation: `pnpm typecheck && pnpm lint`
7. Commit with the exact format specified in the plan
8. Add a progress note: "Integration complete. Capability/MCP server registered."
9. Mark the task as done

## Manifest file format

```json
{
  "integrationId": "<task-uuid-from-inputContext>",
  "integratedAt": "<ISO timestamp>",
  "repoUrl": "<url>",
  "agentSessionId": "<session-uuid>",
  "type": "capability|mcp_server|ui_feature|mixed",
  "filesCreated": ["src/integrations/..."],
  "filesModified": [],
  "dbRecords": [{ "table": "agent_capabilities", "id": "<uuid>" }]
}
```

```

### Read-before-write rule (exact reference files)

| What you're writing | Read this file first |
|--------------------|---------------------|
| API route | `src/app/api/tasks/[id]/route.ts` |
| Service | `src/lib/services/task-service.ts` |
| Page | `src/app/(dashboard)/projects/[id]/page.tsx` |
| Client component | `src/components/projects/project-hub-client.tsx` |
| Server component | `src/app/(dashboard)/plans/[id]/plan-detail-client.tsx` |
| Capability prompt | Fetch existing: `GET /api/agents/:id/capabilities` |

### Fix iteration limit (max 3)

```

Iteration 1: Write file → typecheck → fix errors → typecheck again
Iteration 2: If still failing → read error carefully, fix root cause → typecheck
Iteration 3: If still failing → fix again, last chance
If failing after 3: create subtask "Fix typecheck: <filename> - <error summary>"
and move on to next file

```

### Commit format (exact)

```

feat(integration): add <repo-name> from <repoUrl>

Generated by Agendo repo integrator.
Source: <repoUrl>
Task: <taskId>

```

---

## Area 3: Existing API Routes — What Actually Exists

### Confirmed existing routes

```

POST /api/agents/:id/capabilities → create capability for an agent
GET /api/agents/:id/capabilities → list capabilities
GET /api/agents → list all agents (use to resolve agent IDs)
POST /api/mcp-servers → create MCP server
POST /api/tasks → create task (does NOT accept inputContext via HTTP)
POST /api/sessions → create session + enqueue
POST /api/plans/mcp-save → save_plan MCP tool endpoint
POST /api/plans/:id/execute → start implementer session from plan (takes agentId, capabilityId, model)
GET /api/plans?projectId=... → list plans for a project
GET /api/plans/:id → plan detail

````

### What needs to be created

**`POST /api/integrations`** — single endpoint that handles "Connect a Repo" form submission:

```typescript
// src/app/api/integrations/route.ts

Body: {
  repoUrl: string;        // required
  branch?: string;        // default: main
  docsUrl?: string;       // optional external docs
  projectId: string;      // required — which project to put it under
  title?: string;         // optional override for task title
}

Returns: {
  data: {
    taskId: string;
    sessionId: string;
  }
}
````

**Implementation logic:**

1. `title = title ?? "Integrate: <repo-name-from-url>"`
2. Call `createTask({ title, projectId, status: 'in_progress', inputContext: { args: { repoUrl, branch, docsUrl } } })`
3. Find the planner capability: `getCapabilitiesByAgent(claudeAgentId)` + filter `key === 'repo-planner'`
4. Call `createSession({ taskId, agentId: claudeAgentId, capabilityId: plannerCapabilityId, permissionMode: 'plan' })`
5. Enqueue the session: `enqueueSession({ sessionId })`
6. Return `{ taskId, sessionId }`

**Note:** No new `/api/tasks/:id/approve-plan` endpoint needed. Approval is handled by the existing
`POST /api/plans/:id/execute` — which takes `agentId` + `capabilityId` and starts the implementer.

### The `inputContext.args` pattern

Since the task creation API route doesn't expose `inputContext`, the integration endpoint bypasses
the HTTP layer and calls the service directly (it's a Next.js API route in the same process):

```typescript
import { createTask } from '@/lib/services/task-service';

const task = await createTask({
  title,
  projectId,
  status: 'in_progress',
  inputContext: {
    args: { repoUrl, branch: branch ?? 'main', docsUrl: docsUrl ?? null },
  },
});
```

This is correct — service-level access is appropriate for server-side routes in the same app.

### Template variable access

`interpolatePrompt` in session-runner.ts supports dot-path traversal. So:

- `{{input_context.args.repoUrl}}` → `task.inputContext.args.repoUrl` ✓
- `{{input_context.args.branch}}` → `task.inputContext.args.branch` ✓
- `{{task_title}}` → task.title ✓

The implementer's promptTemplate uses `{{input_context.args.planContent}}`. This means the plan
content is injected into the task's `inputContext.args.planContent` when approval triggers the
implementer session. See Area 5 for exactly how this happens.

---

## Area 4: The UI Form — Where and How

### Location: Project Hub

The "Connect a Repo" entry point lives on the **Project Hub** page (`/projects/:id`).

Why here:

- Integrations are inherently project-scoped (the planner works in `project.rootPath`)
- The project hub already shows tasks, sessions, MCP servers — integrations fit naturally
- Settings page is for global config (agents, MCP servers, plugins) — not project-specific actions

### The button

Add a "Connect Repo" button to `ProjectHubClient` in the project actions area (top-right).
Uses a `Dialog` (shadcn) triggered by the button.

### Form fields

```
┌─────────────────────────────────────────┐
│  Connect a Repository                   │
│                                         │
│  Repo URL *                             │
│  [https://github.com/org/repo         ] │
│                                         │
│  Branch (optional)                      │
│  [main                                ] │
│                                         │
│  Docs URL (optional)                    │
│  [https://docs.example.com            ] │
│                                         │
│  [Cancel]              [Connect Repo →] │
└─────────────────────────────────────────┘
```

Validation: `repoUrl` must be a valid URL starting with `https://github.com/` or `https://gitlab.com/`.

### On submit

1. Disable the "Connect Repo" button, show spinner
2. `POST /api/integrations` with `{ repoUrl, branch, docsUrl, projectId: project.id }`
3. On success: close dialog, navigate to `/sessions/:sessionId`
4. On error: show toast with error message, re-enable button

### Files to create/modify

```
src/app/api/integrations/route.ts                    NEW — the endpoint
src/components/integrations/connect-repo-dialog.tsx  NEW — the dialog form
src/components/projects/project-hub-client.tsx       MODIFY — add button + dialog
```

### Component structure

```tsx
// connect-repo-dialog.tsx
'use client';
interface ConnectRepoDialogProps {
  projectId: string;
  children: React.ReactNode; // trigger button
}
// Uses shadcn Dialog, Form, Input, Button
// On submit: POST /api/integrations → router.push('/sessions/' + sessionId)
```

---

## Area 5: The Approval Checkpoint

### The natural flow (no custom approval UI needed)

After the planner session ends:

1. The plan is stored in the `plans` table (via `save_plan` MCP tool → `POST /api/plans/mcp-save`)
2. The plan is linked to the project via `session → project` chain
3. The plan appears at `/plans?projectId=<id>` and `/plans/:id`
4. The task detail (Kanban card) shows the "Implement: <repo-name>" subtask as `todo`

The user:

1. Clicks the plan to open `/plans/:id`
2. Reads the plan content
3. Clicks "Execute plan" → calls `POST /api/plans/:id/execute`

### What "Execute plan" must do

The existing `POST /api/plans/:id/execute` takes `{ agentId, capabilityId, model }`.

The `executePlan` service in `plan-service.ts` needs to start an implementer session with:

- `taskId`: the "Implement" subtask ID (stored in `plan.metadata.executingTaskId`)
- `agentId`: from request body
- `capabilityId`: implementer capability ID (from request body)
- `permissionMode`: `'bypassPermissions'`
- `initialPrompt`: plan content (so the implementer gets the plan immediately)

**Required change to `executePlan`:**
The service must inject the plan content into the session's `initialPrompt` (or into
`task.inputContext.args.planContent` so the promptTemplate can reference it).

Two options:

- **Option A**: Pass plan content as `initialPrompt` to the session. Simple, direct.
- **Option B**: Update `task.inputContext.args.planContent` before starting the session.
  Then the promptTemplate's `{{input_context.args.planContent}}` interpolates it.

**Recommendation: Option A** — simpler, no extra task update needed, initialPrompt overrides
the promptTemplate anyway (session-runner.ts:135 shows initialPrompt takes priority).

So `executePlan` should:

```typescript
const session = await createSession({
  taskId: plan.metadata.executingTaskId,
  agentId: body.agentId,
  capabilityId: body.capabilityId,
  permissionMode: 'bypassPermissions',
  initialPrompt: plan.content, // ← the plan content IS the initial prompt
});
await enqueueSession({ sessionId: session.id });
```

### Where to find the "Implement" subtask ID

The planner calls `create_subtask` to create the "Implement" subtask. After creating it, the
planner also calls `save_plan` with `metadata.executingTaskId = <subtask-id>`.

The planner prompt must explicitly tell the agent to include this in `save_plan`:

```
After creating all subtasks, call save_plan with the plan content. Include in the plan metadata:
the ID of the "Implement" subtask as executingTaskId. You can get this ID from the create_subtask
response.
```

**Simpler alternative**: Don't use plan metadata. Instead, `executePlan` queries:

```sql
SELECT id FROM tasks WHERE parent_task_id = plan.metadata.planningTaskId
  AND title LIKE 'Implement:%' LIMIT 1
```

But this requires storing `planningTaskId` in plan metadata. Both approaches require a small piece
of metadata from the planner. The `executingTaskId` approach in plan metadata is cleaner since
the Plans system already has this field.

### Approval UI on the plan detail page

The existing `plan-detail-client.tsx` shows plan content. It has an "Execute" flow already
(`/api/plans/:id/execute` endpoint exists). What's needed:

1. The execute dialog needs pre-populated values:
   - `agentId`: Claude agent ID (can be fetched from `/api/agents?slug=claude-code-1`)
   - `capabilityId`: implementer capability ID (needs to be known/discoverable)
2. The dialog should show the plan content for review before executing

The existing UI may already have most of this. Check `plan-detail-client.tsx` for the current
execute dialog — it may need only minor modifications.

---

## Area 6: Implementation Sequence

The core principle: **test the prompts manually before building any UI**. The prompts are the
entire value of this feature. Get them right first.

### Phase 1: Seed capabilities (no code changes)

Create the two capability records via psql or the existing API (not yet seeded):

```sql
-- Get the Claude agent ID
SELECT id FROM agents WHERE slug = 'claude-code-1';

-- Insert planner capability
INSERT INTO agent_capabilities (agent_id, key, label, description, source, interaction_mode, prompt_template, danger_level, timeout_sec)
VALUES (
  '<claude-id>',
  'repo-planner',
  'Repo Integration Planner',
  'Analyzes a GitHub repo and produces an integration plan. Read-only analysis, no code written.',
  'manual',
  'prompt',
  '<PLANNER PROMPT TEXT>',
  0,
  1800  -- 30 min timeout for analysis
);

-- Insert implementer capability
INSERT INTO agent_capabilities (agent_id, key, label, description, source, interaction_mode, prompt_template, danger_level, timeout_sec)
VALUES (
  '<claude-id>',
  'repo-implementer',
  'Repo Integration Implementer',
  'Executes an approved integration plan. Writes code, runs validation, registers results.',
  'manual',
  'prompt',
  '<IMPLEMENTER PROMPT TEXT>',
  2,  -- dangerous: writes files, runs commands
  3600  -- 1 hour timeout
);
```

Alternatively, create them via the Settings UI (Agents → Claude → Add Capability) once the prompts
are written.

### Phase 2: Test planner manually (no UI needed) ★ EARLIEST TEST

Goal: validate that the planner prompt produces a useful, actionable plan.

```bash
# 1. Create a test task via the API with repoUrl in args
curl -X POST http://localhost:4100/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Integrate: token-optimizer",
    "projectId": "<agendo-project-id>",
    "status": "in_progress"
  }'
# Note: inputContext not in route schema — set it directly in psql:
UPDATE tasks SET input_context = '{"args":{"repoUrl":"https://github.com/anthropics/anthropic-cookbook","branch":"main"}}'
WHERE id = '<task-id>';

# 2. Start a planner session via the UI or API
curl -X POST http://localhost:4100/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "<task-id>",
    "agentId": "4af57358-...",
    "capabilityId": "<planner-cap-id>",
    "permissionMode": "plan"
  }'
# Note: no initialPrompt — the capability promptTemplate takes over

# 3. Open the session viewer to watch it work
# /sessions/<session-id>

# 4. Evaluate the plan output:
#    - Is the type classification correct?
#    - Are the subtasks sensible?
#    - Is the plan concrete enough for an implementer?
#    - Are the API calls correct?
# Iterate on the prompt until output is consistently good.
```

Test repos (ordered by increasing complexity):

1. Simple Claude skill: `https://github.com/anthropics/claude-code-skills` (if public)
   OR use the existing `~/.claude/skills/token-optimizer` as a local test
2. MCP server: `https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem`
3. More complex: a real tool with build steps

### Phase 3: Test implementer manually ★ SECOND TEST

After the planner produces a good plan for the token-optimizer:

1. Read the plan content from `/plans?projectId=<agendo-id>`
2. Create the "Implement" subtask manually (or use the one the planner created)
3. Start an implementer session manually:
   ```bash
   curl -X POST http://localhost:4100/api/sessions \
     -d '{"taskId":"<implement-subtask-id>","agentId":"...","capabilityId":"<implementer-cap-id>","permissionMode":"bypassPermissions","initialPrompt":"<plan content>"}'
   ```
4. Watch it work in the session viewer
5. Validate: did it create the capability? Does it appear in Settings → Agents → Claude?

### Phase 4: Add the API endpoint ★ FIRST CODE CHANGE

Create `src/app/api/integrations/route.ts`:

- Accepts `{ repoUrl, branch, docsUrl, projectId, title? }`
- Validates URL format
- Calls `createTask` service with inputContext
- Finds planner capability by `key='repo-planner'`
- Creates session + enqueues
- Returns `{ taskId, sessionId }`

This is the backend for the UI form. No UI yet — test via curl.

### Phase 5: Add the Connect Repo UI

Create `src/components/integrations/connect-repo-dialog.tsx`:

- shadcn Dialog + Form (react-hook-form or uncontrolled)
- 3 fields: repoUrl (required), branch (optional), docsUrl (optional)
- Calls `POST /api/integrations`
- On success: `router.push('/sessions/' + sessionId)`

Modify `src/components/projects/project-hub-client.tsx`:

- Add "Connect Repo" button (GitBranch icon, outline variant)
- Mount the ConnectRepoDialog

### Phase 6: Fix approval flow

Check `plan-detail-client.tsx` — does the "Execute" dialog:

- Pre-populate the correct capability?
- Pass the plan content as `initialPrompt`?

If not, update `executePlan` in `plan-service.ts` to inject `plan.content` as `initialPrompt`.

Ensure the planner saves `metadata.executingTaskId` when calling `save_plan`.

---

## Full File List

### New files

```
src/app/api/integrations/route.ts                    POST endpoint
src/components/integrations/connect-repo-dialog.tsx  UI dialog
```

### Modified files

```
src/components/projects/project-hub-client.tsx       Add Connect Repo button
src/lib/services/plan-service.ts                     Fix executePlan to pass initialPrompt
```

### DB changes (no migration needed — data only)

```sql
-- Two new agent_capabilities rows (created in Phase 1 above)
-- No schema changes
```

### Capability prompt files (not in repo — stored in DB)

The prompt text for planner and implementer are stored as `prompt_template` in the
`agent_capabilities` table. They are long-form text (see Area 1 and Area 2 above for content).

For tracking, the canonical text should also be saved to:

```
src/integrations/repo-planner/prompt.md     (for version control)
src/integrations/repo-implementer/prompt.md (for version control)
```

These are reference copies — the actual prompt in the DB is the operative one.

---

## Agendo Tasks to Create

The following tasks capture this plan as actionable work items:

| #   | Title                                                 | Type | Notes                               |
| --- | ----------------------------------------------------- | ---- | ----------------------------------- |
| 1   | Write repo-planner capability prompt                  | Task | Phase 1+2; most critical            |
| 2   | Write repo-implementer capability prompt              | Task | Phase 3; depends on planner results |
| 3   | Create POST /api/integrations endpoint                | Task | Phase 4; ~30 min                    |
| 4   | Create ConnectRepoDialog component                    | Task | Phase 5; ~45 min                    |
| 5   | Add Connect Repo button to ProjectHubClient           | Task | Phase 5; depends on #4              |
| 6   | Fix executePlan to pass plan content as initialPrompt | Task | Phase 6; ~20 min                    |
| 7   | Manual test: planner on token-optimizer repo          | Task | Phase 2; human + agent              |
| 8   | Manual test: implementer on token-optimizer plan      | Task | Phase 3; human + agent              |

---

## Open Questions / Risks

1. **Plan permission mode and WebFetch**: Does `permissionMode: 'plan'` allow `WebFetch` calls?
   - If not, the planner needs to use `acceptEdits` mode instead (which blocks Bash but allows reads/fetches)
   - **Mitigation**: Test in Phase 2. If WebFetch is blocked in plan mode, switch to `acceptEdits`.

2. **`/data/agendo/repos/` directory**: Does it exist? The implementer clones repos here.
   - Verify: `ls /data/agendo/` — create if absent.
   - **Mitigation**: Include `mkdir -p /data/agendo/repos` in the implementer prompt.

3. **Planner creates subtasks**: The planner is in `plan` mode. Can it call MCP tools (`create_subtask`)?
   - MCP tools are separate from file/bash tools — `plan` mode specifically restricts Claude's bash/file tools.
   - The Agendo `plan` mode is `--approval-mode plan` which restricts file edits and bash, not MCP tools.
   - **Mitigation**: Test in Phase 2. If MCP tools are blocked in plan mode, use `acceptEdits` instead.
   - **Note from MEMORY**: `plan` mode (ExitPlanMode) works with Agendo. MCP tools work in plan mode.

4. **`plan.metadata.executingTaskId`**: This requires the planner to pass the subtask ID back in
   `save_plan`. The `save_plan` MCP tool's schema is `{ content, title, planId, sessionId }` — no
   `metadata` field exposed. The service `savePlanFromMcp` would need a `metadata` parameter added.
   - **Simpler alternative**: The approval UI queries subtasks of the planning task and finds
     the one titled "Implement:\*". No metadata needed.

5. **promptTemplate placeholder depth**: `{{input_context.args.planContent}}` requires the task's
   `inputContext.args.planContent` to be set before the session runs. If `executePlan` passes
   content via `initialPrompt` instead (Option A), this is not needed.
   - **Recommendation**: Use Option A (initialPrompt). Simpler, already supported.

6. **Large repos**: Some repos are huge. The planner uses WebFetch (single pages) — not a full
   clone — so memory is not a concern. But the plan might be very long for complex repos.
   - **Mitigation**: The plan content is stored in a TEXT column (no size limit). Not a concern.
