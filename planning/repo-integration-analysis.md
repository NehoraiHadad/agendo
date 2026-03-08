# Repo Integration Analysis

> Analysis of how to build an agent-driven repo integration system for Agendo.
> Author: Claude | Date: 2026-03-08 | Status: **Final**

---

## 1. Current State Summary

### 1.1 repo-sync service (`src/lib/services/repo-sync/`)

A standalone file-sync library. It does exactly one thing well: clone an upstream GitHub repo (shallow) and copy specific paths to local destinations, tracking state in a JSON manifest.

**What works:**

- `syncTarget()` — clone, compare commit SHA, copy changed files, update manifest
- `syncAll()` — batch multiple targets
- Manifest tracks per-target commit + synced file list for incremental sync

**What doesn't:**

- Targets are **hardcoded** in `targets.ts` — one entry: `token-optimizer → ~/.claude/skills/token-optimizer`
- No API, no UI, no DB backing — adding a new repo requires a code change
- Completely disconnected from the plugin system, the agent system, and the MCP server
- Never called from any startup path, worker, or scheduled job — it's a dead library

### 1.2 Plugin architecture (`src/lib/plugins/`)

A complete, well-designed extension framework that is **entirely non-functional in production**.

**What was built:**

- `types.ts` — full interface set: `AgendoPlugin`, `PluginContext`, `HookRegistry`, `JobRegistry`, `McpToolRegistry`, `PluginStore`
- `plugin-registry.ts` — singleton registry with hook dispatch, job management, MCP tool management, error counting/auto-disable
- `plugin-loader.ts` — `loadPlugins()`, `enablePlugin()`, `disablePlugin()`, `updatePluginConfig()`
- `plugin-context.ts` — scoped context factory (logger, hooks, jobs, mcpTools, store)
- `plugin-store.ts` — DB-backed key-value store using `plugin_store` table
- `builtin/repo-sync/index.ts` — fully implemented plugin (different from the service — does `git pull` on _local_ repos, not remote-to-local copy)
- `src/app/api/plugins/route.ts` + `[id]/route.ts` — API routes for list/get/enable/disable
- `src/components/settings/plugin-cards.tsx` — UI with enable toggle
- `src/lib/services/plugin-service.ts` — service wrapper

**What doesn't work (5 critical gaps):**

| Gap                               | Evidence                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DB tables missing**             | `plugins` and `plugin_store` tables not in database. Migration `drizzle/0005_wide_payback.sql` exists but was never applied. `pg_tables` query confirms: no `plugins` table.                                                                      |
| **`loadPlugins()` never called**  | Only defined in `plugin-loader.ts:23`. Grep finds zero other call sites — not in `src/worker/index.ts`, not in any Next.js startup route. The registry is empty at runtime.                                                                       |
| **`dispatchHook()` never called** | Only defined in `plugin-registry.ts:146`. Hook events (`task:created`, `session:started`, etc.) are never fired by `task-service.ts` or `session-process.ts`.                                                                                     |
| **MCP tool bridge missing**       | `pluginRegistry.getAllMcpTools()` is never called. The MCP server is a **separate esbuild bundle** (`dist/mcp-server.js`) with no process-level connection to the plugin registry. Even if plugins registered tools, agents would never see them. |
| **pg-boss job bridge is a stub**  | `plugin-context.ts:48`: `async enqueue(...): Promise<string> { // TODO: Wire to pg-boss in phase 2; return 'not-implemented'; }`. Jobs registered via `ctx.jobs.register()` never flow to pg-boss.                                                |

### 1.3 What the two repos built overlap at

The `repo-sync service` and the `plugin builtin/repo-sync` solve **different problems** with similar names:

- **Service** (`src/lib/services/repo-sync/`): Downloads files from a remote GitHub repo to a local path. One-way remote-to-local copy. Good for syncing Claude skills from external repos.
- **Plugin** (`src/lib/plugins/builtin/repo-sync/`): Tracks already-local git repos and runs `git pull`. Tools: `sync_repo`, `list_tracked_repos`. Good for keeping project working directories up-to-date.

Neither delivers the vision.

### 1.4 What actually works and is usable

**`mcp_servers` table + `resolveSessionMcpServers()`** (`src/lib/services/mcp-server-service.ts`) — this is the most relevant working primitive for repo integration:

- DB-backed registry of external MCP server definitions (command, args, env)
- `resolveSessionMcpServers(projectId)` computes the final MCP server list per session with project overrides
- Sessions already receive this list and inject servers alongside the built-in Agendo MCP server
- `importFromInstalledPlugins()` can auto-discover from Claude plugins, Gemini settings, Codex config

**`start_agent_session` MCP tool** (`src/lib/mcp/tools/session-tools.ts`) — agents can spawn subagents. This is the right mechanism for an "analyze this repo" step.

**`agentCapabilities` table** — capabilities with prompt templates and interaction modes. A "repo integrator" could be a capability.

---

## 2. Gap Analysis

Numbered by priority for bridging the gap from current state to the vision.

1. **No agent-driven analysis step.** The vision requires: "give me a repo URL → agent figures out what it is." No such workflow or agent exists. Nobody decides whether a repo is a skill, an MCP server, or a library.

2. **Repo targets are hardcoded.** `src/lib/services/repo-sync/targets.ts` has one hard-coded entry. There is no API, UI, or DB table for registering new repos at runtime.

3. **Plugin DB tables not created.** Migration `0005_wide_payback.sql` never applied — `plugins` and `plugin_store` tables don't exist. Any call to `loadPlugins()` would fail immediately with a DB error.

4. **Plugin system never initialized.** `loadPlugins()` is never called. The entire plugin framework is dead code at runtime, including the repo-sync builtin plugin.

5. **Hooks are never dispatched.** Even when plugins are initialized someday, Agendo core events (`task:created`, `project:created`, `session:started`) are never piped to `pluginRegistry.dispatchHook()`.

6. **Plugin MCP tools can't reach agents.** The MCP server is a separate esbuild bundle (`dist/mcp-server.js`) with no shared memory or IPC with the Next.js plugin registry. `getAllMcpTools()` is never called. The correct architecture for this bridge would be: plugin MCP tools registered via HTTP to the Agendo API, then the MCP server fetches them dynamically — but that bridge doesn't exist.

7. **No build step for incoming repos.** An MCP server repo needs `npm install` + compilation before it can be registered. No such pipeline exists.

8. **No integration result model.** There's no DB table tracking "I integrated repo X, it became MCP server Y, it was registered on date Z." No audit trail, no re-sync trigger.

9. **The `services` field from the design doc is missing from the real implementation.** `planning/plugin-architecture.md:106` shows `ctx.services` (tasks, projects, agents, sessions) in the plugin context interface. The actual `plugin-context.ts` doesn't implement it — plugins can't query Agendo data at all.

10. **No UI entry point for the repo integration flow.** The settings plugin page exists but only shows hardcoded builtin plugins. There's no "Connect a repo" button, no URL input, nothing.

---

## 3. Use Case Walkthroughs

### Case 1: Claude Skill Repo (e.g., `token-optimizer`)

**Repo shape:** Contains `skills/<skill-name>/` with a `CLAUDE.md` file inside.

**Ideal flow:**

1. User pastes repo URL in Agendo UI
2. Agendo spawns an "integrator" agent session with the repo URL as input
3. Agent clones the repo, inspects structure, finds `skills/` directory
4. Agent calls a (hypothetical) `install_claude_skill` MCP tool with `repoUrl` + `skillName`
5. MCP tool triggers `repo-sync service`: clone → copy `skills/<name>/` → `~/.claude/skills/<name>/`
6. Agendo records the integration in a `repo_integrations` table

**Agendo primitives it maps to:**

- `repo-sync service` — already does the file copy correctly (gap: needs an API to call it)
- Claude's `~/.claude/skills/` directory — Claude CLI auto-discovers skills here, no capability needed

**What's missing:**

- An API endpoint to trigger `syncTarget()` with a dynamic `SyncTarget`
- An `install_claude_skill` MCP tool (or equivalent)
- A `repo_integrations` table to record the result
- The "integrator" agent capability/session setup

**Verdict:** This is the closest to working. The sync engine exists. It needs an agent wrapper and an API surface.

---

### Case 2: MCP Server Repo (e.g., a Node.js MCP tool server)

**Repo shape:** Contains a Node.js project with `index.js` or a built binary that speaks MCP over stdio.

**Ideal flow:**

1. User pastes repo URL
2. Integrator agent clones the repo, reads `package.json` + README
3. Agent detects MCP server (looks for `@modelcontextprotocol/sdk` in deps, or `mcp` in description)
4. Agent runs `npm install && npm run build` in a sandbox
5. Agent calls `register_mcp_server` MCP tool: name, command, args, env
6. Agendo inserts into `mcp_servers` table (this is the RIGHT primitive — it exists)
7. Agent optionally links it to the current project via `project_mcp_servers`

**Agendo primitives it maps to:**

- `mcp_servers` table + `resolveSessionMcpServers()` — **already exists and works**
- `project_mcp_servers` — **already exists**
- The API at `src/app/api/mcp-servers/` would need to expose a create endpoint callable from MCP

**What's missing:**

- A `register_mcp_server` MCP tool (the REST API exists but isn't exposed as an MCP tool)
- A sandboxed build step (clone + npm install + build)
- Validation that the registered server actually speaks MCP before inserting to DB
- A `repo_integrations` table to track the clone path + build artifacts

**Verdict:** The target primitive (`mcp_servers` table) already exists and is the right abstraction. The work is in building the agent's analysis + build step + registration MCP tool.

---

### Case 3: Code Library Repo (e.g., a utility library or reference codebase)

**Repo shape:** A general code library. Agents working in projects that depend on this library should be able to read/reference it.

**Ideal flow:**

1. User pastes repo URL + optionally specifies which projects should have access
2. Integrator agent clones the repo to a stable local path (e.g., `/data/agendo/repos/<org>/<name>`)
3. Agent registers the path so it can be referenced in agent context/preambles
4. For projects that depend on it: the working dir or env overrides reference the clone path

**Agendo primitives it maps to:**

- No clean existing primitive. Approximations:
  - `project.envOverrides` — could inject `LIBRARY_PATH=/data/agendo/repos/...`
  - Session preamble text — agent told "you have access to library X at path Y"
  - A new "project attachment" concept would be the right primitive

**What's missing:**

- Agendo has no concept of "reference repos" or "attached libraries"
- No preamble injection mechanism based on project config
- No stable clone management (where do clones live? who updates them?)

**Verdict:** This is the most underserved case. The `project.envOverrides` and preamble are the closest hooks, but they require manual setup. A proper "attached repo" concept would need a new DB table and preamble generation logic.

---

## 4. Architecture Recommendation

### Should we build on the plugin architecture?

**No — not as the primary mechanism.** The plugin system is designed for trusted, in-process, statically-imported code shipped with Agendo. The gaps to make it functional (5 critical fixes) are real work, and even when fixed, the MCP bridge gap means plugin-registered tools need an HTTP intermediary to reach agents. The plugin system is the right place for Agendo's own internal extensions (scheduling, hooks into core events), not for user-submitted external repos.

**The plugin system is worth fixing in parallel** (it's clean code with good design), but repo integration should not block on it.

### Should repo-sync stay separate or merge into the plugin system?

**Stay separate.** The `repo-sync service` is a useful, testable, focused library. It should gain an API surface (dynamic targets, trigger endpoint) rather than being absorbed into the plugin system. The plugin builtin could eventually _use_ the service internally, but they serve different purposes.

### Architecture for the minimal viable path

The right model is: **agent-as-integrator, Agendo as primitive registry**.

```
User submits repo URL
    ↓
Agendo creates a "repo integration" task
    ↓
Agendo spawns an "integrator" agent session on that task
(via start_agent_session, bypassPermissions mode)
    ↓
Agent: clone repo, analyze structure, decide integration type
    ↓
Agent calls Agendo MCP tools to register primitives:
  • Skill repo:  install_claude_skill(repoUrl, skillName, branch)
  • MCP server:  register_mcp_server(name, command, args, env)
  • Library:     attach_repo_to_project(projectId, repoUrl, localPath)
    ↓
Agendo records result in repo_integrations table
Agent marks task done
```

The agent does the intelligence (what is this repo?). Agendo provides the MCP tools to register results against its own primitives. The result is persisted.

### Role of agent vs. automated infrastructure

| Step                    | Who does it                        | Why                                                                          |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| Analyze repo structure  | Agent                              | Requires reading README, package.json, directory layout — judgment call      |
| Decide integration type | Agent                              | Skill vs MCP server vs library — not always obvious, may require asking user |
| Clone + file copy       | Infrastructure (repo-sync service) | Deterministic, tested, no AI needed                                          |
| Build MCP server        | Agent (runs shell commands)        | Build steps vary per repo, errors need interpretation                        |
| Register in DB          | Agendo MCP tool                    | Structured, validated, atomic                                                |
| Schedule re-sync        | Infrastructure (pg-boss cron)      | Periodic, no judgment needed                                                 |

### Trade-offs

| Option                                            | Pros                                                              | Cons                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Agent-as-integrator** (recommended)             | Handles ambiguous repos; extensible; uses existing infrastructure | Slower than pure automation; requires a session                   |
| Plugin architecture first                         | Clean in-process model                                            | 5 critical gaps to fix before anything works; MCP bridge unsolved |
| Pure automation (pattern-match on repo structure) | Fast, no agent needed                                             | Brittle; edge cases everywhere; no user interaction               |
| Manual (user fills in forms)                      | Simple, no AI needed                                              | Defeats the purpose; doesn't scale                                |

---

## 5. Proposed Next Steps (ordered)

### Step 1 — Apply migration 0005 (1 hour)

Run `drizzle/0005_wide_payback.sql` against production DB. Creates `plugins` and `plugin_store` tables. Without this, no plugin functionality works.

### Step 2 — Add `repo_integrations` table (half day)

New DB table tracking each integration attempt:

```sql
CREATE TABLE repo_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  integration_type TEXT NOT NULL, -- 'skill' | 'mcp_server' | 'library'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'analyzing' | 'active' | 'failed'
  local_path TEXT,           -- where the repo is cloned on disk
  target_primitive_id TEXT,  -- references mcp_servers.id or similar
  target_primitive_type TEXT,
  task_id UUID REFERENCES tasks(id), -- the integration task
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Add `src/lib/services/repo-integration-service.ts` with CRUD.

### Step 3 — Add MCP tools for primitive registration (1 day)

New tools in the Agendo MCP server (`src/lib/mcp/tools/`):

- `install_claude_skill(repoUrl, skillName, branch?)` — triggers repo-sync service, records result
- `register_mcp_server(name, command, args, env?)` — inserts into `mcp_servers` table
- `list_repo_integrations()` — lets agent check what's already registered

These tools make the agent's output actionable. The agent can't directly modify the DB; it goes through MCP.

### Step 4 — Make repo-sync service dynamic (half day)

Add an API endpoint to trigger a sync with a dynamic `SyncTarget`:

```
POST /api/repo-sync/trigger
Body: { repoUrl, branch, mappings: [{ src, dest }] }
```

This lets the MCP tool `install_claude_skill` trigger a sync without code changes.

### Step 5 — Create "repo integrator" capability (1 day)

Add a new capability to Claude (and optionally Codex/Gemini) with a prompt template that:

1. Instructs the agent to analyze the given repo URL
2. Lists the available MCP tools for registration
3. Defines the decision rubric (skills dir → skill, MCP SDK dep → MCP server, else → library)
4. Asks the agent to confirm the integration type before proceeding

This is a template-mode or prompt-mode capability triggered by the UI.

### Step 6 — UI entry point (half day)

Add a "Connect a Repo" button in Settings or Projects view:

- Form: repo URL, optional branch
- On submit: creates a task + spawns the integrator agent
- Shows integration status from `repo_integrations` table

### Step 7 — Fix plugin system (separate track, 2-3 days)

In parallel or after the above:

1. Call `loadPlugins()` in worker startup (`src/worker/index.ts`)
2. Add `pluginRegistry.dispatchHook()` calls in `task-service.ts` (task:created, task:completed) and `session-process.ts` (session:started, session:ended)
3. Build MCP bridge: add a `GET /api/plugins/mcp-tools` endpoint; MCP server calls it at startup to load dynamic tools
4. Wire pg-boss in `createJobRegistry()` (replace `'not-implemented'` stub)

This makes the plugin system actually work for future internal extensions.

---

## Summary

The current codebase has the right **primitives** (repo-sync engine, mcp_servers table, start_agent_session tool) but they're disconnected. The plugin system is well-designed but entirely non-functional (5 critical gaps, no DB tables). The path forward is not to fix the plugin system first — it's to build an agent-driven integration flow directly on top of the working primitives, using the agent as the intelligence layer and Agendo MCP tools as the registration interface. The plugin system can be fixed in parallel and will serve as the extension mechanism for Agendo's own internals, not for user-submitted external repos.
