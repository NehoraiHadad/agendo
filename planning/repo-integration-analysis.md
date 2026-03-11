# Repo Integration Analysis

> Author: Claude | Date: 2026-03-09 | Status: **v3 — evaluating actual implementation**

---

## What Was Built

The user implemented a simpler, more opinionated approach than the planning doc recommended. Here's what exists:

### Files

```
src/app/(dashboard)/integrations/page.tsx           Server component — fetches + renders
src/app/(dashboard)/integrations/integrations-client.tsx  UI — list + add + remove buttons
src/components/integrations/connect-repo-dialog.tsx  Dialog form — single Textarea input
src/app/api/integrations/route.ts                   GET (list) + POST (create)
src/app/api/integrations/[name]/route.ts            DELETE (spawn remover agent)
scripts/seed-repo-integration-capabilities.ts       Seeds 3 capability prompts into DB
src/lib/services/project-service.ts                 +getOrCreateSystemProject()
```

### Architecture

```
User pastes source (URL / npm package / text description)
  │
  ▼
POST /api/integrations
  → creates task in "Agendo System" project (global, not per-project)
  → finds repo-planner capability (any enabled agent)
  → spawns planner session in plan mode
  → redirects user to session viewer
  │
  ▼
Planner agent (plan mode — read-only)
  → reads task (gets source + integrationName)
  → fetches README/package.json/llms.txt from source URL
  → classifies: capability | ui_feature | library | unrecognized
  → creates subtask "Implement: <name>"
  → calls save_plan with full instructions for implementer
  → calls start_agent_session → auto-spawns implementer
  → marks own task done
  │
  ▼
Implementer agent (bypassPermissions)
  → clones/obtains source
  → writes files / registers capabilities / configures MCP servers
  → calls save_snapshot (intended as audit trail)
  → commits with standard format
  → marks task done
```

**Delete flow:**

```
User clicks Remove → DELETE /api/integrations/[name]
  → finds original task by integrationName in inputContext
  → creates "Remove integration: <name>" task
  → spawns repo-remover agent (bypassPermissions)
  → redirects to session viewer to watch it work
```

### Key Design Decisions vs. Planning Doc

| Aspect              | Planning doc                                 | Actual implementation                            |
| ------------------- | -------------------------------------------- | ------------------------------------------------ |
| Source input        | Structured form (URL + branch + docsUrl)     | Free-form textarea (any text)                    |
| Scope               | Per-project                                  | Global (system project)                          |
| Approval checkpoint | Required between plan and implement          | **None — planner auto-spawns implementer**       |
| Audit trail         | `src/integrations/<name>/manifest.json` file | `save_snapshot` MCP tool (DB)                    |
| Removal             | Static (planned but not built)               | Agent-driven (repo-remover)                      |
| Integration types   | capability / mcp_server / ui_feature / mixed | capability / ui_feature / library / unrecognized |
| Capability seeding  | Manual DB insert / Settings UI               | `pnpm seed:integrations` script (idempotent)     |

---

## What's Good

**1. Free-form source input is the right UX.** A single textarea that accepts anything — URL, package name, or description — is much lower friction than a structured form. The agent is intelligent enough to figure out what "add a linear integration" means without a URL. This correctly puts the intelligence in the agent, not in the UI.

**2. Global integrations page is architecturally correct.** Integrations extend Agendo itself. They don't belong to a specific project. Removing the per-project scope simplifies the mental model. The "Agendo System" project as container is a clean solution.

**3. Agent-driven removal is elegant.** Instead of trying to statically track every change an agent might make, the remover agent reads the snapshot and git history, warns about post-integration modifications, and removes surgically. This handles cases that a static manifest can't — e.g., when the integration committed changes across multiple files or when subsequent work touched the same files.

**4. The planner auto-spawns the implementer.** This makes the system truly autonomous. The user watches the planner work, the planner produces a plan AND starts execution. No button-clicking in between. Fully hands-off.

**5. Seeding is properly integrated.** `pnpm db:seed` now includes `seed-repo-integration-capabilities.ts`. The seed is idempotent (upsert on conflict). This means the system bootstraps itself correctly on first install.

**6. MCP server type was deliberately removed.** The planning doc had `mcp_server` as a type. The implementation removed it and has the planner handle this under `library`. This is pragmatic — the capability/ui_feature/library distinction covers the real cases. An MCP server repo would be a `library` with specific registration instructions in the plan.

---

## Issues Found

### Issue 1 — Critical: `save_snapshot` schema mismatch

The implementer prompt tells the agent to call `save_snapshot` with this shape:

```json
{
  "integrationName": "<repo-name>",
  "commits": ["abc123"],
  "filesCreated": ["src/integrations/..."],
  "dbRecords": [{ "type": "capability", "id": "<uuid>", "agentId": "<uuid>" }]
}
```

But the actual `save_snapshot` MCP tool (`src/lib/mcp/tools/snapshot-tools.ts:93`) takes:

```json
{
  "name": "...",
  "summary": "...",
  "filesExplored": ["..."],
  "findings": ["..."],
  "hypotheses": ["..."],
  "nextSteps": ["..."]
}
```

These don't overlap at all. The agent will either call the tool with wrong fields (which will be ignored or cause a Zod validation error), or it will adapt to the actual tool signature and lose the structured audit data entirely.

**The remover depends on this data.** The remover prompt says:

> Look at the task snapshots for the shape: `{ integrationName, commits[], filesCreated[], dbRecords[] }`

But those fields don't exist in any snapshot. The remover will find a snapshot with `keyFindings.findings[]` (text strings), not `filesCreated[]` (file paths). The structured removal flow will fail — the agent will fall back to the "inspect git log" path, which works but loses precision.

**Fix options:**

A. **Fit the data into the existing snapshot schema** — store `filesCreated` in `filesExplored`, store commit SHAs in `findings`, store `dbRecords` as JSON strings in `findings`. Update both prompts to use this encoding. The snapshot tool works today without any schema change.

B. **Add custom fields to `save_snapshot`** — add `integrationData?: Record<string, unknown>` to the snapshot schema as a passthrough JSONB field. Clean but requires changing the MCP server, the snapshot API, and the DB schema.

C. **Use `add_progress_note` as the audit trail instead** — the implementer calls `add_progress_note` with a JSON payload after each action. The remover reads progress notes from `get_task`. Notes are text, not structured — less reliable for querying but zero schema changes needed.

**Recommendation: Option A.** Use the existing snapshot fields with a clear encoding convention. Update the prompts to match. No code changes needed.

Prompt fix for implementer:

```
Call save_snapshot with:
  name: "Integration: <integrationName>"
  summary: "Integration of <source> completed. Type: <type>. Commit: <SHA>."
  filesExplored: <list of filesCreated — paths of files you created>
  findings: <commit SHAs, one per line: "commit:<SHA>">
  nextSteps: <DB record JSON strings, one per line: '{"type":"capability","id":"<uuid>","agentId":"<uuid>"}'>
```

Prompt fix for remover:

```
Read snapshot.keyFindings:
  filesExplored = files that were created (to delete)
  findings = lines starting with "commit:" contain the commit SHAs
  nextSteps = JSON strings of DB records to delete
```

Ugly encoding, but works with zero infrastructure changes. If it gets messy, do Option B properly.

---

### Issue 2 — Moderate: No human review before code is written

The planner auto-spawns the implementer immediately after producing the plan. For a `capability` type (just DB record + skill files), this is completely safe. For a `ui_feature` type (new React pages, modified sidebar navigation), the implementer writes code and commits it without any human seeing the plan first.

This is a **deliberate design choice** — the user explicitly chose autonomy over oversight. It's the right default for the use case (this is an agent platform, not a consumer product). But it has consequences:

- If the planner misclassifies the type, the implementer will build the wrong thing
- If the planner's instructions are wrong, broken code gets committed
- The user watches a planner session end, then a new implementer session appears — but they may not be watching

**Not a bug, but a risk.** Worth documenting. The mitigation is that the user is redirected to the planner's session viewer and can see the plan as it's being written. If the plan looks wrong, they could cancel the implementer session before it does anything destructive. But there's no prompt to do so.

If oversight is desired, the simplest fix is: **the planner doesn't call `start_agent_session`**. Instead, it ends with the plan saved and the "Implement" subtask created. The user sees the plan in the Plans UI and clicks "Execute" when ready. This is exactly what the planning doc recommended.

---

### Issue 3 — Minor: `library` type is underspecified

The planner classifies repos as `capability | ui_feature | library | unrecognized`. The prompt says:

> library — npm/pip package, SDK, CLI tool — adds new functionality to Agendo

But the plan format template says:

> [For npm packages / other:] describe how to obtain — install globally, clone, download, etc.

"Adds new functionality to Agendo" means what exactly? If someone pastes `https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem`, is that `library`? What does the implementer do with it — install it as an npm package? Register it as an MCP server? Clone it locally?

The planner prompt doesn't tell the agent to use `POST /api/mcp-servers` for MCP server repos. The `mcp_server` type from the planning doc was removed, but the actual integration path for MCP server repos wasn't replaced.

**Fix:** Add explicit guidance to the planner prompt for MCP server repos:

```
### MCP server repos (detected by: @modelcontextprotocol/sdk in package.json)
Classify as: library
In the plan's "Register in Agendo" section, include:
  npm install && npm run build (or equivalent)
  curl POST http://localhost:4100/api/mcp-servers with command/args pointing to built binary
```

---

### Issue 4 — Minor: Capabilities seeded for ALL agents

`seed-repo-integration-capabilities.ts` creates `repo-planner`, `repo-implementer`, and `repo-remover` for **every active AI agent** (Claude, Codex, Gemini).

`POST /api/integrations` then does:

```typescript
.where(and(eq(agentCapabilities.key, 'repo-planner'), eq(agentCapabilities.isEnabled, true), eq(agents.isActive, true)))
.limit(1)
```

This means whichever agent happens to be returned first gets the planner. If Codex has the capability and is returned first, the planner will be a Codex session. Codex might handle the planner prompt differently than Claude — particularly `start_agent_session` which goes through Agendo's MCP tools.

The planner prompt was written for Claude's behavior (`WebFetch`, reading raw.githubusercontent.com URLs, etc.). Codex and Gemini behave differently.

**Fix:** In `POST /api/integrations`, filter to Claude specifically:

```typescript
.innerJoin(agents, and(eq(agents.id, agentCapabilities.agentId), eq(agents.binaryName, 'claude')))
```

Or: only seed the capabilities for Claude in the seed script (check `agent.binaryName === 'claude'` before inserting).

---

## Gap Analysis

1. **`save_snapshot` format mismatch** (critical) — implementer and remover prompts use fields that don't exist in the snapshot schema. Structured removal will fail.

2. **`library` type missing MCP server path** — no guidance for registering MCP server repos. They'll be classified as library with no clear implementation path.

3. **No capability for planner agent selection** — `POST /api/integrations` finds any agent with `repo-planner`. Should filter to Claude.

4. **No error recovery in planner → implementer chain** — if `start_agent_session` fails (e.g., the planner capability is wrong), the planner session ends cleanly but no implementer starts. The user sees the planner end; nothing happens. No error is surfaced.

5. **The integrations list has no link to sessions** — `integrations-client.tsx` shows status (done/in_progress/todo) but no way to click into the session that performed the integration. The user can't see what the agent did or re-open the log. A "View session" link would complete the UX.

6. **No re-run on failure** — if the implementer fails (typecheck errors, API call failed), the task is left in a partial state. There's no way to re-run the implementer with the same plan without manually spawning a new session.

7. **`getOrCreateSystemProject` uses `process.cwd()` as rootPath** — this is the Agendo app directory. Correct for integrations that modify Agendo itself. But if Agendo is deployed in a different working directory than expected, this could mismatch.

8. **`DELETE /api/integrations/[name]` has no confirmation in the UI** — `integrations-client.tsx` uses `window.confirm()`. Fine for now, but confirm dialogs are blocked in some browser contexts and feel janky. A shadcn AlertDialog would be better.

---

## Use Case Walkthroughs

### Case 1: Claude skill (example skill repo)

**Input:** `https://github.com/anthropics/claude-code-skills` or a local Claude skill repo

**Planner reads:** README, CLAUDE.md, skill prompt text.
**Classifies:** `capability`
**Plan says:** Register capability via API with the skill's prompt template.
**Implementer:** Calls `POST /api/agents/<claude-id>/capabilities` with the prompt. Done — no files written, no build step.
**Snapshot:** `filesExplored: []`, `findings: ["commit:<SHA>"]`, `nextSteps: ['{"type":"capability","id":"..."}']`
**Removal:** DELETE capability via API. No files to remove.

**Status:** Works well. Lowest risk. Fully covered by the current prompts (modulo the snapshot format fix).

---

### Case 2: MCP server repo

**Input:** `https://github.com/modelcontextprotocol/servers`

**Planner reads:** README, package.json (finds `@modelcontextprotocol/sdk`).
**Classifies:** `library` (mcp_server type was removed)
**Plan says:** ??? — the planner prompt doesn't tell the agent to use `POST /api/mcp-servers`.

**This case is currently broken.** The planner will produce a generic "library" plan with vague instructions. The implementer won't know to call the MCP server registration endpoint.

**Fix:** Add MCP server detection + registration path to the planner prompt (see Issue 3 above).

---

### Case 3: Natural language description

**Input:** `add a linear integration with task sync`

**Planner reads:** No URL to fetch. Uses knowledge + description.
**Classifies:** Likely `ui_feature` (needs a React component + API route) or `unrecognized`.

**If ui_feature:** Plan says create a new page, API route, and some Linear API calls. Implementer writes code.
**If unrecognized:** Planner logs "Cannot integrate: no clear integration path" and stops.

**Status:** This case tests the agent's judgment. For a well-known service like Linear, Claude should handle it correctly. For obscure tools, `unrecognized` is the safe fallback. The flow works — but the quality of the result depends entirely on the planner's knowledge.

---

## Architecture Assessment

The implementation makes a correct core choice: **the agent IS the intelligence**. There's no pattern-matching infrastructure, no plugin registry, no type system. The planner reads the source and decides. This is the right approach.

The simplifications from the planning doc are mostly good:

- Free-form input > structured form ✓
- Global scope > per-project ✓
- Agent-driven removal > static manifest ✓
- Seeded capabilities > manual DB setup ✓

The one simplification that introduces risk is **removing the approval checkpoint**. The planning doc's checkpoint exists not for bureaucratic reasons — it's so the user can catch a misclassified or malformed plan before code is written. For a system that modifies its own codebase autonomously, this matters.

However, the current implementation is internally consistent. If you accept "fully autonomous" as the design goal, the implementation achieves it cleanly.

---

## Proposed Next Steps (ordered)

### Step 1 — Fix the snapshot schema mismatch (critical, ~30 min)

Update the implementer prompt in `seed-repo-integration-capabilities.ts` to fit the actual `save_snapshot` schema. Update the remover prompt to read the right fields. Re-run `pnpm seed:integrations`.

No code changes — just prompt engineering.

### Step 2 — Add MCP server path to planner prompt (~30 min)

Add detection rule and registration instructions for MCP server repos to the planner prompt:

- Detect: `@modelcontextprotocol/sdk` in package.json
- Register via: `POST /api/mcp-servers`
- Build step: `npm install && npm run build`

### Step 3 — Filter planner lookup to Claude agent (~15 min)

In `src/app/api/integrations/route.ts`, add `eq(agents.binaryName, 'claude')` to the planner lookup query.

### Step 4 — Add session link to integrations list (~30 min)

In `integrations-client.tsx`, add a "View session" link on each integration row. This requires storing `sessionId` in the task's `inputContext` (or querying sessions by `taskId`). The task already has `id`, so query `GET /api/sessions?taskId=<id>` to find the session.

### Step 5 — Manual test: planner on a skill repo

Run the actual planner. Submit `https://github.com/anthropics/claude-code-skills` (or any real skill repo). Watch it in the session viewer. Evaluate:

- Is the type classification correct?
- Does the plan make sense?
- Does `start_agent_session` succeed from plan mode?
- Does the implementer session start?
- Does the snapshot get saved correctly (after Step 1 fix)?

Iterate on the prompts until the end-to-end flow works.

### Step 6 — (Optional) Add approval checkpoint

If the fully-autonomous behavior is too risky in practice, add a checkpoint:

1. Remove `start_agent_session` call from the planner prompt
2. The planner saves the plan and creates the "Implement" subtask — then stops
3. The Integrations page shows integrations with status "pending review"
4. Add a "Run implementer" button next to each pending integration

This doesn't require changing the API or DB schema — just the planner prompt and a button in the UI.

---

## Summary

The implementation is lean, correct in its core decisions, and immediately testable. The three-capability design (planner / implementer / remover) with a global integrations page is the right abstraction.

**One critical bug to fix before testing:** the snapshot schema mismatch will break the removal flow. Fix the prompts first.

**One underspecified case:** MCP server repos have no clear path through the `library` type. Add explicit guidance to the planner prompt.

Everything else can be discovered and fixed through actual use.
