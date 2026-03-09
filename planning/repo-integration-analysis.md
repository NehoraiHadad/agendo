# Repo Integration Analysis

> Analysis of how to build an agent-driven repo integration system for Agendo.
> Author: Claude | Date: 2026-03-09 | Status: **Revised v2 — multi-agent pipeline**

---

## Vision (final)

The goal is not to "register" external repos — it's to **embed them as native features inside Agendo**.

A user gives the system a repo URL, docs, README, or anything that explains the project. A **multi-agent pipeline** handles the rest: one agent plans, optionally others validate, one implements. The result is a first-class capability inside Agendo — same UI, same patterns, no separate server.

**Each agent is a Claude Code session embedded in the application** — exactly like a conversation with Claude Code, but triggered from Agendo with the right context, tools, and permissions. The user watches each step in real-time via the session viewer and approves before the pipeline advances.

**The pipeline structure is not hardcoded.** The planning agent reads the repo and decides what steps are needed. A simple skill repo might need only plan + implement. A complex MCP server might need plan + security review + build validation + implement. The planner creates the subtasks; Agendo orchestrates them.

---

## 1. Current State Summary

### 1.1 repo-sync service (`src/lib/services/repo-sync/`)

A standalone file-sync library. Clones an upstream GitHub repo (shallow) and copies specific paths to local destinations, tracking state in a JSON manifest.

**What works:**

- `syncTarget()` — clone, compare commit SHA, copy changed files, update manifest
- `syncAll()` — batch multiple targets

**What doesn't:**

- Targets hardcoded in `targets.ts` — one entry: `token-optimizer → ~/.claude/skills/token-optimizer`
- No API, no UI, no DB — adding a repo requires a code change
- Never called from any startup path or scheduled job — dead library

### 1.2 Plugin architecture (`src/lib/plugins/`)

A complete, well-designed extension framework that is **entirely non-functional in production**.

**What was built:** full types, registry, loader, context factory, DB-backed store, builtin repo-sync plugin, API routes, settings UI.

**What doesn't work (5 critical gaps):**

| Gap                               | Evidence                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **DB tables missing**             | `plugins` and `plugin_store` not in DB. Migration `0005_wide_payback.sql` exists but never applied.        |
| **`loadPlugins()` never called**  | Defined in `plugin-loader.ts:23`. Zero call sites — not in worker, not in Next.js startup.                 |
| **`dispatchHook()` never called** | Only defined in `plugin-registry.ts:146`. Core events never piped to it.                                   |
| **MCP tool bridge missing**       | MCP server is a separate esbuild bundle. `getAllMcpTools()` never called. Plugin tools never reach agents. |
| **pg-boss bridge is a stub**      | `plugin-context.ts:48`: `return 'not-implemented'`. Jobs never flow to pg-boss.                            |

### 1.3 What actually works

- **`mcp_servers` table + `resolveSessionMcpServers()`** — DB-backed registry of external MCP servers, injected per session. Right primitive for MCP server repos.
- **`start_agent_session` MCP tool** — agents can spawn subagents. The mechanism for triggering the integrator.
- **`agentCapabilities` table** — prompt templates + interaction modes. A "repo integrator" is a natural capability.
- **Session viewer + SSE streaming** — user can watch the integration agent work in real time.

---

## 2. The Integration Agent — What It Actually Is

The "repo integrator" is **not a new kind of system**. It's a Claude Code session with:

- The external repo cloned into a temp directory (or the URL passed as context)
- Agendo's own codebase as the working directory
- `bypassPermissions` mode so it can write files, run typecheck, run tests
- A capability prompt that guides it through the 5-step pipeline below
- The user watching via the session viewer in real time

This means most of the infrastructure already exists. What's missing is the **prompt design**, the **pipeline structure**, and the **generated code tracking**.

---

## 3. The Multi-Agent Pipeline

The pipeline has a fixed entry and exit, but a variable middle. The planning agent decides the middle.

```
ENTRY: user submits repo URL / docs / README
  │
  ▼
┌─────────────────────────────────────────────────┐
│  AGENT 1: PLANNER  (plan mode, bypassPermissions) │
│                                                   │
│  • Clones repo, reads structure + docs            │
│  • Understands: what is this? what does it do?    │
│  • Decides: what type of integration is needed?   │
│  • Writes a structured plan (save_plan MCP tool)  │
│  • Creates subtasks for each remaining step       │
│    via create_subtask MCP tool                    │
│  • Stops — does NOT write any code                │
└─────────────────────────────────────────────────┘
  │
  ▼
[CHECKPOINT: user sees the plan + subtask list, approves / edits]
  │
  ▼
┌─────────────────────────────────────────────────┐
│  AGENT 2..N: VALIDATION AGENTS  (optional)       │
│  Created by the planner if needed, e.g.:         │
│  • Security review agent                         │
│  • Build validation agent (npm install + build)  │
│  • Compatibility check agent                     │
│  Each produces a structured verdict              │
└─────────────────────────────────────────────────┘
  │
  ▼
[CHECKPOINT: user sees validation results if any concerns]
  │
  ▼
┌─────────────────────────────────────────────────┐
│  AGENT N+1: IMPLEMENTER  (bypassPermissions)     │
│                                                   │
│  • Receives: plan + validation results as context │
│  • Writes code following Agendo's patterns        │
│  • Runs: pnpm typecheck → pnpm lint → pnpm test  │
│  • Fixes failures (max 3 iterations)             │
│  • Commits with standard format                  │
│  • Calls register_integration MCP tools          │
│  • Marks integration active                      │
└─────────────────────────────────────────────────┘
  │
  ▼
EXIT: new capability live in Agendo
```

### Why separate planner and implementer?

- **The planner doesn't know what the repo contains upfront.** Separating analysis from execution lets the plan be reviewed before anything is written to disk.
- **The implementer gets a clean, structured brief.** It doesn't need to re-analyze the repo — it gets the plan as context and focuses on code quality.
- **Validation steps are repo-specific.** A Claude skill needs no build step. An MCP server needs `npm install + build`. A full UI feature might need a design review. The planner decides; the pipeline adapts.
- **Each step is auditable.** The user can see what each agent did, read its session log, and understand the chain of decisions.

### How the planner creates the pipeline

The planning agent uses existing Agendo MCP tools:

```
create_subtask("Validate: security review", assignee=claude)
create_subtask("Validate: npm build", assignee=claude)
create_subtask("Implement integration", assignee=claude)
save_plan({ type, filesToCreate, filesToModify, dbChanges, ... })
```

The orchestration layer (Agendo) runs subtasks in order after each checkpoint passes. No custom orchestration code needed — this is just the existing task/subtask system.

---

## 4. Marking Generated Code

All code generated by the integration agent must be identifiable. Three layers:

**Layer 1 — Git commits**
Every commit from an integration run uses a consistent format:

```
feat(integration): add <name> from <repo>

Generated by Agendo repo integrator.
Source: https://github.com/org/repo
Integration ID: <uuid>
```

**Layer 2 — Integration manifest file**
Each integration creates a manifest at `src/integrations/<name>/manifest.json`:

```json
{
  "integrationId": "<uuid>",
  "repoUrl": "https://github.com/...",
  "integratedAt": "2026-03-09T...",
  "agentSessionId": "<uuid>",
  "filesCreated": ["src/components/...", "src/app/api/..."],
  "filesModified": ["src/components/settings/..."],
  "dbRecords": [{ "table": "agent_capabilities", "id": "..." }]
}
```

This is the source of truth for "what did the agent create." Enables clean removal.

**Layer 3 — `repo_integrations` DB table**
Tracks status, links to task, links to session log, links to manifest. Makes integrations visible in the UI.

**What NOT to do:** inline code comments like `// generated by agent`. Fragile, noisy, removed by refactors.

---

## 5. What the Agent Needs as Context

### The infrastructure is fixed — but the agent still reads and verifies

Agendo is not a SaaS product that changes constantly. Once deployed, the codebase structure is **stable**. But this doesn't mean the prompt replaces reading the code. The agent must **actually read and verify** before making decisions.

The balance:

- **Prompt gives direction** — where to look, what to read first, what output shape is expected
- **Agent reads and verifies** — reads actual files, confirms patterns before using them, doesn't assume

A static "trust this map" description in the prompt can be wrong or outdated. An agent that reads the actual file cannot be.

### What the planner prompt must include

**1. Where to start** (orientation, not a substitute for reading):

- "Read `CLAUDE.md` first — it contains the patterns and constraints"
- "Read `planning/03-data-model.md` — it's the authoritative data model"
- "Before deciding what to create, read one existing example of the same type"

**2. The plan format** — the JSON schema the planner must output. This is the one truly static piece. The agent knows the shape its output must take before it starts.

**3. Stopping rules** — explicit:

- Do not write any code
- Do not modify any files
- Stop after `save_plan` is called

**4. The repo input** — README, package.json, top-level structure passed as the task's initial context.

### What the implementer prompt must include

**1. The approved plan JSON** — the brief.

**2. Read-before-write rule** — before writing each file, read an existing file of the same type first:

- New API route → read `src/app/api/tasks/route.ts` first
- New service → read `src/lib/services/task-service.ts` first
- New page → read an existing `(app)/` page first

**3. Validate-as-you-go** — run `pnpm typecheck && pnpm lint` after each file, fix before moving to the next. Not all at the end.

**4. Commit format** — how to tag the integration commit.

---

## 6. Use Case Walkthroughs (revised)

### Case 1: Claude Skill Repo (`token-optimizer`)

**What the agent finds:** `skills/token-optimizer/` directory with `CLAUDE.md` inside.

**Integration spec output:**

```json
{
  "type": "capability",
  "filesToCreate": [],
  "dbChanges": [
    {
      "table": "agent_capabilities",
      "action": "insert",
      "data": {
        "key": "token-optimize",
        "label": "Token Optimizer",
        "source": "skill",
        "interactionMode": "prompt"
      }
    }
  ],
  "extraSteps": ["sync skill files to ~/.claude/skills/token-optimizer/"]
}
```

**Result:** New capability in Agendo. User opens a session with Claude, selects "Token Optimizer", it works — because the skill files are synced and Claude auto-discovers them.

**Code generated:** minimal — just DB record + sync trigger. No new React components needed.

---

### Case 2: MCP Server Repo

**What the agent finds:** Node.js project with `@modelcontextprotocol/sdk` in `package.json`.

**Integration spec output:**

```json
{
  "type": "mcp_server",
  "extraSteps": ["npm install", "npm run build"],
  "filesToCreate": ["src/integrations/my-mcp/manifest.json"],
  "dbChanges": [
    {
      "table": "mcp_servers",
      "action": "insert",
      "data": {
        "name": "my-mcp",
        "command": "node",
        "args": ["/data/agendo/repos/my-mcp/dist/index.js"]
      }
    }
  ]
}
```

**Result:** MCP server appears in Agendo's MCP server list. Sessions for configured projects automatically get this server's tools.

**Code generated:** manifest file only. DB record created via service.

---

### Case 3: Full UI Feature Repo

**What the agent finds:** A standalone Next.js tool or utility with its own UI.

**Integration spec output:**

```json
{
  "type": "ui_feature",
  "filesToCreate": [
    "src/app/(app)/tools/my-tool/page.tsx",
    "src/app/api/tools/my-tool/route.ts",
    "src/components/tools/my-tool.tsx"
  ],
  "filesToModify": ["src/components/nav/sidebar.tsx"],
  "dbChanges": []
}
```

**Result:** New page in Agendo's sidebar. User navigates to it like any other Agendo page.

**Code generated:** full React components + API routes, following Agendo's App Router patterns.

---

## 7. Gap Analysis (updated)

1. **No integration pipeline exists.** The 5-step flow doesn't exist anywhere. The agent, the spec format, the approval UI, the validation loop — all missing.

2. **`repo_integrations` table missing.** No DB table to track what was integrated, when, by which session, what files were created.

3. **No "integration spec" format defined.** The structured JSON that drives the Generate step doesn't exist. This is the core contract between Analyze and Generate.

4. **No capability prompt for the integrator.** The most important artifact — what the agent is told to do and how — doesn't exist.

5. **No approval UI.** The checkpoint between Analyze and Generate has no UI in Agendo. User needs to see the spec and approve/reject.

6. **Repo-sync service not callable via API.** The sync engine works but has no HTTP endpoint. The agent can't trigger it — it would have to call it directly via shell, which breaks the MCP tool model.

7. **Plugin tables not migrated.** `plugins` and `plugin_store` missing from DB. Not blocking for the integration agent, but needed if we want scheduled re-sync jobs.

8. **Plugin system dead.** `loadPlugins()` never called. Not blocking for MVP, but hooks (`task:created`, etc.) would be useful for triggering re-syncs.

9. **No removal flow.** The manifest enables clean removal, but no agent or UI exists to perform it. An integration can be added but not removed cleanly.

10. **No re-sync trigger.** When the upstream repo updates, there's no scheduled job or webhook to re-run the integration.

---

## 8. Architecture Recommendation

**The multi-agent pipeline maps directly onto Agendo's existing task/subtask system.** No new orchestration infrastructure is needed. The planner creates subtasks; Agendo runs them in order.

**Build the pipeline, not a framework.** The planner agent is just a capability with a well-crafted prompt. The implementer is another capability. The MCP tools they use are the interface to Agendo's primitives. There is no "integration engine" to build — just prompts, a DB table, and a handful of MCP tools.

**The agent IS the intelligence.** Don't build pattern-matching heuristics. Let the planner read the repo and decide what the pipeline looks like. The plan format constrains its output to what Agendo can act on.

**The plugin system is not on the critical path.** Fix it in parallel as Agendo's internal extension mechanism.

### What's genuinely new to build

| What                                | Why new                                                           |
| ----------------------------------- | ----------------------------------------------------------------- |
| `repo_integrations` table           | Tracks integration state, plan, manifest, links to tasks/sessions |
| Plan format (TypeScript type + Zod) | Contract between planner and implementer                          |
| Planner capability prompt           | The most important artifact — determines plan quality             |
| Implementer capability prompt       | Receives plan + context, writes code, runs checks                 |
| `register_integration` MCP tools    | Safe, atomic DB writes from within agent sessions                 |
| Repo-sync API endpoint              | Lets agents trigger file sync without direct FS access            |
| Approval UI checkpoint              | User sees plan + subtasks before implementation starts            |
| UI entry point ("Connect a Repo")   | Form that creates the parent task and kicks off the planner       |

---

## 9. Proposed Next Steps (ordered)

### Step 1 — `repo_integrations` table + service

```sql
CREATE TABLE repo_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'planning' | 'awaiting_approval' | 'implementing' | 'active' | 'failed'
  plan JSONB,                    -- structured plan from the planner agent
  manifest_path TEXT,            -- path to src/integrations/<name>/manifest.json
  parent_task_id UUID REFERENCES tasks(id),
  planner_session_id UUID REFERENCES sessions(id),
  implementer_session_id UUID REFERENCES sessions(id),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Step 2 — Plan format (TypeScript type + Zod schema)

The structured contract the planner produces and the implementer consumes:

```typescript
type IntegrationPlan = {
  name: string;
  description: string;
  repoUrl: string;
  integrationType: 'capability' | 'mcp_server' | 'ui_feature' | 'mixed';
  filesToCreate: string[];
  filesToModify: string[];
  dbChanges: Array<{ table: string; action: 'insert' | 'update'; data: Record<string, unknown> }>;
  extraSteps: string[]; // e.g. "npm install", "npm run build"
  validationSubtasks: string[]; // titles of validation subtasks the planner wants
  agendoPatternsToFollow: string[]; // e.g. "src/app/api/tasks/route.ts for API patterns"
  commitMessage: string;
  estimatedComplexity: 'low' | 'medium' | 'high';
};
```

### Step 3 — Planner capability prompt

The most important artifact. Tells the agent to:

- Clone and read the repo (README, package.json, source structure)
- Produce a valid `IntegrationPlan` JSON
- Call `create_subtask` for each validation step it wants
- Call `save_plan` with the plan
- **Stop — write no code**

### Step 4 — `register_integration` MCP tools

New tools in the Agendo MCP server:

- `create_integration_record(repoUrl, name)` — creates row in `repo_integrations`
- `save_integration_plan(integrationId, plan)` — stores plan, sets status `awaiting_approval`
- `register_capability(data)` — inserts into `agent_capabilities`
- `register_mcp_server(data)` — inserts into `mcp_servers`
- `finalize_integration(integrationId, manifestPath)` — sets status `active`

### Step 5 — Implementer capability prompt

Receives: plan JSON + validation results + Agendo pattern examples.
Does: writes code, runs `pnpm typecheck && pnpm lint && pnpm test`, fixes failures (max 3 iterations), commits, calls `finalize_integration`.

### Step 6 — Repo-sync API endpoint

```
POST /api/repo-sync/trigger
Body: { repoUrl, branch, src, dest }
```

Lets the implementer trigger file sync (for skill repos) without direct FS access.

### Step 7 — UI entry point ("Connect a Repo")

Form in Settings or Projects:

- Repo URL (required)
- Branch (optional, default: main)
- Docs URL (optional — extra context for the planner)

On submit: creates parent task → spawns planner session → user lands in session viewer watching the planner work.

### Step 8 — Approval UI (plan checkpoint)

After the planner finishes, the task moves to `awaiting_approval`. A UI component shows:

- Integration type + description
- Files to be created / modified
- DB changes
- Subtasks the planner wants to create

User can approve, reject, or edit the plan before the implementer runs. This is the most important UX moment — it's where the user understands what's about to happen to their codebase.

### Step 9 — End-to-end test with token-optimizer

Run the full pipeline manually with the token-optimizer repo. Fix whatever breaks. This is the first real validation of whether the prompt design is good enough.

### Step 10 — Fix plugin system (parallel track)

1. Apply migration 0005 (plugins + plugin_store tables)
2. Call `loadPlugins()` in worker startup
3. Wire `dispatchHook()` into task-service and session-process
4. Build HTTP bridge for plugin MCP tools → MCP server
5. Replace pg-boss stub with real enqueue

---

## Summary

The vision: give Agendo a repo URL, a multi-agent pipeline handles it. A planner reads the repo and produces a structured integration plan + creates subtasks for the steps needed. The user approves. An implementer executes the plan, writes code following Agendo's patterns, validates with typecheck/lint/tests, and registers the result. The output is a native feature inside Agendo.

**The pipeline structure is not hardcoded — the planner decides it.** Simple repos get plan + implement. Complex ones get plan + validation agents + implement. The task/subtask system is the orchestrator.

**Each agent is just a Claude Code session** with the right prompt, context, and MCP tools. No new runtime infrastructure needed. What needs to be built: a DB table, a plan format, two capability prompts, a handful of MCP tools, an approval UI, and an entry point form.

The plugin system is well-designed but entirely non-functional and not on the critical path. Fix it in parallel.
