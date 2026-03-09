# Repo Integration Analysis

> Analysis of how to build an agent-driven repo integration system for Agendo.
> Author: Claude | Date: 2026-03-09 | Status: **Revised — vision clarified**

---

## Vision (clarified)

The goal is not to "register" external repos — it's to **embed them as native features inside Agendo**.

A user gives the system a repo URL (or docs, README, anything that explains the project). An agent analyzes it, proposes what needs to change in Agendo's codebase, the user approves, and the agent writes the actual integration code. The result is a first-class capability inside Agendo — same UI, same patterns, no separate server.

**The agent is essentially a Claude Code session embedded inside the application.** Like this conversation, but triggered from within Agendo with the right context, tools, and permissions. The user watches it work in real-time via the session viewer.

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

## 3. The 5-Step Integration Pipeline

```
1. ANALYZE
   Agent reads the repo (clone + read README, package.json, source files)
   Produces a structured "integration spec":
   {
     repoUrl, name, description,
     type: 'capability' | 'mcp_server' | 'ui_feature',
     filesToCreate: [...],
     filesToModify: [...],
     dbChanges: [...],
     agendoPatterns: [...] // which existing patterns to follow
   }

2. APPROVE  ← checkpoint
   Spec shown to user in Agendo UI
   User can edit, reject, or approve
   Nothing written to disk until approval

3. GENERATE
   Agent writes code based on the spec
   Follows Agendo's patterns (CLAUDE.md + relevant example files injected as context)
   Tags all generated code (see §4)

4. VALIDATE  ← automated
   pnpm typecheck → if fails, agent fixes
   pnpm lint → if fails, agent fixes
   pnpm test → if fails, agent fixes
   Max 3 iterations, then surfaces to user

5. REGISTER
   DB records created (capability, mcp_server entry, integration log)
   Commit created with standard message format
   Integration marked 'active' in repo_integrations table
```

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

For the agent to write code that fits Agendo, it needs:

1. **`CLAUDE.md`** — already injected automatically into every Claude session
2. **Relevant example files** — if creating a new capability: existing capability + API route + service. Injected into the prompt as reference.
3. **The integration spec** (from step 1) — structured, JSON
4. **The repo content** — README, package.json, key source files. Cloned to temp dir.
5. **A clear prompt** — "You are integrating X into Agendo. Follow the patterns in the example files. Use the spec. Tag your commits."

The prompt template is the **most important artifact to get right**. It determines quality and reliability.

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

**Build the integration agent first, not the plugin system.** The plugin system has 5 critical gaps and doesn't help with the core vision. The integration agent needs:

- A DB table (`repo_integrations`)
- A capability record (prompt template)
- An approval UI component
- A manifest format

The plugin system is worth fixing in parallel as Agendo's internal extension mechanism, but it's not on the critical path.

**The repo-sync service stays separate.** It's a useful, focused library. Expose it via API endpoint; the agent calls it via MCP tool rather than running it directly.

**The agent IS the intelligence.** Don't build pattern-matching heuristics ("if package.json has X then it's type Y"). Let the agent read the repo and decide. The spec format constrains its output to what Agendo can act on.

---

## 9. Proposed Next Steps (ordered)

### Step 1 — `repo_integrations` table + service (half day)

```sql
CREATE TABLE repo_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  name TEXT NOT NULL,
  integration_type TEXT NOT NULL, -- 'capability' | 'mcp_server' | 'ui_feature'
  status TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'analyzing' | 'awaiting_approval' | 'generating' | 'active' | 'failed'
  spec JSONB,                    -- the integration spec from Analyze step
  manifest_path TEXT,            -- path to src/integrations/<name>/manifest.json
  task_id UUID REFERENCES tasks(id),
  agent_session_id UUID REFERENCES sessions(id),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Step 2 — Integration spec format (half day)

Define the JSON schema for the integration spec. This is the contract between Analyze and Generate steps. Write it as a TypeScript type + Zod schema so the agent's output can be validated.

### Step 3 — Integrator capability prompt (1 day)

Write the prompt template that guides the agent through all 5 steps. This is the most important artifact. It should:

- Tell the agent exactly what to produce in the Analyze step
- Show the spec format with examples
- List Agendo's patterns (with file references)
- Define the commit message format
- Tell it to stop after Analyze and wait for approval

### Step 4 — Repo-sync API endpoint (2 hours)

```
POST /api/repo-sync/trigger
Body: { repoUrl, branch, src, dest }
```

Allows the agent to trigger file sync via MCP tool rather than direct FS access.

### Step 5 — Approval UI (half day)

A component in Agendo that shows the integration spec after the Analyze step and lets the user approve/reject. Could be a modal in the session viewer or a dedicated page linked from the task.

### Step 6 — `register_integration` MCP tools (half day)

New tools in the Agendo MCP server:

- `create_integration_record(spec)` — inserts into `repo_integrations`
- `register_capability(data)` — inserts into `agent_capabilities`
- `register_mcp_server(data)` — inserts into `mcp_servers`
- `finalize_integration(id, manifestPath)` — marks integration active

These tools make the Generate → Register steps safe and atomic.

### Step 7 — End-to-end test with token-optimizer (1 day)

Run a full integration session manually: paste the token-optimizer repo URL, watch the agent analyze, approve the spec, watch it generate, validate, register. Fix whatever breaks.

### Step 8 — UI entry point (half day)

"Connect a Repo" button in Settings or Projects. Form: repo URL + optional branch. On submit: creates task + triggers integrator session.

### Step 9 — Fix plugin system (parallel track, 2–3 days)

1. Apply migration 0005 (plugins + plugin_store tables)
2. Call `loadPlugins()` in worker startup
3. Wire `dispatchHook()` into task-service and session-process
4. Build HTTP bridge for plugin MCP tools → MCP server
5. Replace pg-boss stub with real enqueue

---

## Summary

The vision is: give Agendo a repo URL, an agent reads it and writes the integration code, the result is a native feature inside Agendo. The agent is a Claude Code session — the same technology as this conversation — with Agendo's codebase as context and the right capability prompt.

The current codebase has the runtime infrastructure (session runner, streaming, bypassPermissions, MCP tools). What's missing is the pipeline structure: the DB table, the spec format, the prompt, the approval UI, and the MCP registration tools.

The plugin system is well-designed but entirely non-functional and not on the critical path. Fix it in parallel as an internal extension mechanism.
