# Orchestrator Batch Audit — March 8, 2026

## Summary

- **Total tasks:** 18
- **Total commits:** 34
- **Total files changed:** 134 (11,833 insertions, 780 deletions)
- **Fully delivered:** 8 tasks
- **Partially delivered:** 4 tasks (missing requirements or uncommitted fixes)
- **Investigation/research only:** 6 tasks (3 research, 3 investigations)

### Critical Integration Gaps

1. **Uncommitted fixes (3 tasks):** `97788b7c` (forked session UI), `cc552916` (MCP auto-include labels), `d495d3b7` (Codex model switching RPC) — agents described fixes in progress notes but never committed them
2. **Mislabeled commits:** `f54461e` says "docs(research): Copilot CLI" but contains test files; `7850ed9` says "refactor(cli)" but contains the research doc
3. **Cross-task commit pollution:** `4b20686` (repo-sync) contains the entire plugin architecture (`341c44fd`), making git attribution impossible
4. **Build safety gap:** `e8b9789b` skipped tsc in `next build` but never added `pnpm typecheck` to `build:all` — type errors can slip through
5. **Dead code:** `19fcbb6e` commented out code instead of deleting it

## Task Overview Table

| #   | Layer | Task ID  | Title                             | Commits | Status                                    |
| --- | ----- | -------- | --------------------------------- | ------- | ----------------------------------------- |
| 1   | 0     | e8b9789b | Fix production build OOM          | 1       | Partial — missing typecheck in build:all  |
| 2   | 0     | c64eff4b | Refactor headless CLI runner      | 5       | Complete (mislabeled commits)             |
| 3   | 0     | cc552916 | MCP not available in sessions     | 0       | Investigation only — UI fix not committed |
| 4   | 0     | 97788b7c | Forked session UI bug             | 0       | Fix NOT committed — bug remains           |
| 5   | 1     | 19fcbb6e | Switch Agent user-initiated       | 1       | Complete (dead code left)                 |
| 6   | 1     | c08aa9d3 | Summary mechanism investigation   | 4       | Complete — spawned 3 subtasks, all done   |
| 7   | 1     | 3e34686f | Full mode redundant initialPrompt | 0       | Weak — vague findings, no action          |
| 8   | 2     | 14bc1b3c | MCP selection in chat creation    | 4       | Complete                                  |
| 9   | 2     | d495d3b7 | Model switching verification      | 2       | GAP — Codex fix not committed             |
| 10  | 2     | 718b1c33 | Plan Version History              | 2       | Complete — full TDD delivery              |
| 11  | 2     | 9dd266b9 | Native worktree support           | 3       | Complete — pragmatic Claude-only          |
| 12  | 2     | 5bc68dd1 | Capability management UX          | 3       | Complete — all 5 improvements             |
| 13  | 2     | d4848bc9 | Execution order/sequencing        | 2       | Partial — no dependsOn, no drag-drop      |
| 14  | 3     | 4447ef8e | Copilot CLI research              | 2       | Complete (commits mislabeled)             |
| 15  | 3     | 506e5a54 | Memory system research            | 2       | Complete — 886-line research doc          |
| 16  | 4     | bff31038 | Repo-sync agent                   | 2       | Complete (scope creep into plugins)       |
| 17  | 4     | 378e5c9d | Settings/config redesign          | 1       | Complete — cleanest delivery              |
| 18  | 4     | 341c44fd | Plugin architecture               | 0\*     | Complete but no own commit                |

\* All plugin code committed under repo-sync's `4b20686`

---

## Detailed Audit

### Layer 0: Blockers

#### e8b9789b — Fix production build OOM during TypeScript checking

**Requested:** Fix `pnpm build:all` OOM failure during the TypeScript checking phase of `next build` (heap hits ~509MB limit on 4GB server). Suggested fixes included increasing heap limit, stopping PM2 services during build, skipping type checking in build, or using SWC-only. Task also mandated committing after every significant change (previous attempt was lost due to missing commit).
**Delivered:** Added `typescript.ignoreBuildErrors: true` to `next.config.ts` so `next build` skips tsc. The progress notes claim `build:all` was updated to run `pnpm typecheck` first, but the actual `package.json` still shows `"build:all": "pnpm build && pnpm worker:build && pnpm build:mcp"` — no `pnpm typecheck` step was added.
**Commits:**

- `b780ce6` fix(build): skip tsc in next build to avoid OOM
  **Key files changed:**
- `next.config.ts`
  **Issues/Notes:**

1. **Incomplete delivery**: The agent's progress note says "Updated `build:all` to run `pnpm typecheck` first" but this change is NOT in the commit. Type errors can silently slip through production builds since `next build` now ignores them and `build:all` does not run `pnpm typecheck`.
2. The fix itself is sound (separating type checking from build), but without the `build:all` update, type safety is reduced rather than preserved.

---

#### c64eff4b — Refactor headless CLI runner — shared utility, tests, DRY

**Requested:** Extract duplicated CLI spawn/env/timeout logic from `src/lib/gemini/headless.ts` and `src/lib/services/summarization-providers.ts` into shared utilities (`cli-runner.ts`, `ndjson-stream.ts`). TDD workflow required. Commit after each file.
**Delivered:** Clean refactoring with two new utility modules and two consumer updates. Tests written (23 new tests across 2 test files). The `headless.ts` file went from ~203 lines to ~140 lines, and `summarization-providers.ts` lost ~47 lines of inline spawn logic.
**Commits:**

- `0e05997` refactor(cli): add shared CLI runner utility
- `f7ad4ab` refactor(cli): add shared NDJSON stream utility
- `ec29eaf` refactor(cli): update headless.ts to use shared cli-runner + ndjson-stream
- `7850ed9` refactor(cli): update summarization-providers.ts to use shared cli-runner
- `f54461e` docs(research): GitHub Copilot CLI integration research _(mislabeled — actually contains the test files)_
  **Key files changed:**
- `src/lib/utils/cli-runner.ts` (new, 119 lines)
- `src/lib/utils/ndjson-stream.ts` (new, 106 lines)
- `src/lib/gemini/headless.ts` (refactored, -84 lines)
- `src/lib/services/summarization-providers.ts` (refactored, -47 lines)
- `src/lib/utils/__tests__/cli-runner.test.ts` (new, 133 lines)
- `src/lib/utils/__tests__/ndjson-stream.test.ts` (new, 169 lines)
- `planning/copilot-cli-research.md` (new, 233 lines — bundled into 7850ed9, unrelated to the refactor)
  **Issues/Notes:**

1. **Mislabeled commit**: `f54461e` is titled "docs(research): GitHub Copilot CLI integration research" but contains the test files for the CLI runner refactor, not documentation.
2. **Stray file**: `planning/copilot-cli-research.md` (233 lines of research doc) was bundled into commit `7850ed9` (the summarization-providers refactor).
3. The agent ran twice (two sessions with overlapping work), producing two progress note summaries with slightly different stats. The second run's commits landed.

---

#### cc552916 — Investigate: enabled MCPs not available in sessions

**Requested:** Investigate why enabled MCP servers are not available in agent sessions despite being enabled in settings UI.
**Delivered:** Thorough investigation confirming root cause: `is_default=false` on all user MCP servers. The `resolveSessionMcpServers()` function only includes `is_default=true` servers, and imported servers default to `is_default=false`. Progress notes describe UI label improvements (renaming "Default" to "Auto-include" with tooltips) but these changes were never committed.
**Commits:**

- No dedicated commit. Related pre-existing commits: `951fad2`, `aecc92d`, `3ab2811`, `cc46762`
  **Key files changed:**
- (No files changed by this task)
  **Issues/Notes:**

1. **UI changes NOT committed**: The "Auto-include" rename described in progress notes does not exist in the repo.
2. **Root cause identified but not fixed**: The DB fix (`UPDATE mcp_servers SET is_default = true WHERE enabled = true`) was recommended but not applied.
3. The investigation itself was thorough and well-documented.

---

#### 97788b7c — Bug: Forked session UI doesn't load old messages

**Requested:** Fix bug where forked session UI doesn't load old messages until user sends a message.
**Delivered:** Root cause identified: in `session-chat-view.tsx`, the empty-state loading div (with `h-full`) rendered whenever `stream.events.length === 0`, pushing parent display items off-screen. Fix: add `parentDisplayItems.length === 0` to the condition.
**Commits:**

- **No commit found.** The fix is not present in git history.
  **Key files changed:**
- `src/components/sessions/session-chat-view.tsx` (fix described but NOT committed)
  **Issues/Notes:**

1. **Fix was NOT committed — bug remains unfixed.** The agent identified the root cause and described the fix but the change was lost. This is the same failure pattern the orchestrator tried to prevent with explicit "commit after every significant change" directives.
2. The diagnosis appears sound — the empty-state div hiding parent events is a plausible root cause.

---

### Layer 1: Switch Agent

#### 19fcbb6e — Refactor Switch Agent flow to be user-initiated

**Requested:** Remove `enqueueSession()` call in `session-fork-service.ts` so that switching agents creates a new idle session (not auto-started). User manually sends the first message.
**Delivered:** The `enqueueSession()` call was commented out. Tests updated.
**Commits:**

- `c1e4170` refactor(sessions): make Switch Agent flow user-initiated
  **Key files changed:**
- `src/lib/services/session-fork-service.ts` (commented out enqueueSession, 7 lines)
- `src/lib/services/__tests__/session-fork-service.test.ts` (5 test assertions updated)
  **Issues/Notes:**

1. **Conflicting progress notes**: The Gemini agent first reports success, then says "I have reverted all the changes I made." The committed code shows the intended change, so the final state appears correct.
2. **Dead code**: The import and call for `enqueueSession` were commented out rather than deleted, contradicting "don't leave dead code paths."

---

#### c08aa9d3 — Investigate summary mechanism used by Switch Agent flow

**Requested:** Verify how the session summary is generated and consumed in the Switch Agent flow.
**Delivered:** Comprehensive investigation tracing the full flow. Created 3 bug subtasks, all completed with commits:

- Error parsing fix in Switch Agent dialog
- Capability validation in fork-to-agent
- Abort + context meta UX polish
  **Commits (from subtasks):**
- `8658f05` fix(sessions): parse nested error object in Switch Agent dialog
- `0d7a29b` fix(sessions): validate capability in fork-to-agent
- `aa778b6` feat(sessions): add abort + context meta to Switch Agent dialog
  **Key files changed:**
- `src/components/sessions/agent-switch-dialog.tsx` (error parsing + abort controller + context meta badge)
- `src/lib/services/session-fork-service.ts` (capability validation, 71 lines)
- `src/lib/services/__tests__/session-fork-service.test.ts` (90+ lines new tests)
- `src/app/api/sessions/[id]/fork-to-agent/route.ts` (accept capabilityId)
  **Issues/Notes:** Best follow-through of all tasks — investigation spawned actionable subtasks that were all completed.

---

#### 3e34686f — Investigate: Switch Agent 'full' mode sends redundant initialPrompt

**Requested:** Investigate whether `initialPrompt` is redundant in 'full transcript' mode. Fix the known turn-dropping bug.
**Delivered:** Vague one-line findings with no actionable detail.
**Commits:**

- No commits.
  **Key files changed:**
- None
  **Issues/Notes:**

1. **Sparse findings**: Progress notes only say "Found key findings about 'full' mode redundancy" without details. Compare to `c08aa9d3` which spawned 3 actionable subtasks.
2. **Known bug not addressed**: The silent turn-dropping bug was confirmed but no subtask or fix was created.
3. Weakest deliverable of the entire batch.

---

### Layer 2: Features

#### 14bc1b3c — Add MCP server selection to project chat creation flow

**Requested:** Add MCP server picker to the new chat/session creation UI. Show available MCP servers, allow toggling per session, pass selections to API.
**Delivered:** MCP server picker added to `QuickLaunchDialog` with collapsible checkbox list. API routes updated. Fetches both global and project-level servers for smart defaults.
**Commits:**

- `cc46762` feat(sessions): add MCP selection and worktree toggle to session creation
- `aecc92d` feat(sessions): per-session MCP server selection (prerequisite)
- `951fad2` feat(mcp): add MCP server registry with per-project config (prerequisite)
- `3ab2811` feat(mcp): improve MCP server config UI and validation
  **Key files changed:**
- `src/components/sessions/quick-launch-dialog.tsx` (+156 lines MCP picker UI)
- `src/app/api/projects/[id]/sessions/route.ts` (added `mcpServerIds`)
- `src/app/api/sessions/route.ts` (added `mcpServerIds`)
- `src/components/sessions/start-session-dialog.tsx` (MCP picker)
- `src/lib/services/mcp-server-service.ts` (resolveByMcpServerIds)
- `src/lib/worker/session-runner.ts` (session MCP priority chain)
  **Issues/Notes:** Clean delivery. `cc46762` is a combined commit shared with worktree task `9dd266b9`.

---

#### d495d3b7 — Verify: mid-session model switching works end-to-end

**Requested:** Verify mid-session model switching for Claude, Codex, and Gemini. Fix issues found.
**Delivered:** Research doc and Claude `--model` flag fix. Claude and Gemini verified working. Codex identified as broken.
**Commits:**

- `b912af1` feat(models): improve model discovery for all CLIs + fix Claude --model flag
- `09e724e` fix(worker): codex adapter cleanup and session exit logic fixes
  **Key files changed:**
- `src/lib/services/model-service.ts` (Codex JSON-RPC model/list, Gemini require() models.js)
- `src/lib/worker/adapters/claude-adapter.ts` (+`--model` flag passthrough)
- `src/lib/worker/adapters/codex-app-server-adapter.ts` (MCP config fix)
- `planning/model-discovery-research.md`
  **Issues/Notes:**

1. **GAP**: Progress notes claim Codex `setModel()` was fixed with `setDefaultModel` RPC, but the codebase still shows the old `this.model = model` implementation. The fix was either never committed or was lost. Codex model switching remains deferred-only.

---

#### 718b1c33 — Plan Version History

**Requested:** Auto-versioning for plans so every revision is preserved. Schema, service, API, UI.
**Delivered:** Full TDD implementation. Schema: `plan_versions` table. Service: save, list, get, compare, deduplicate. API: GET/POST versions endpoints. UI: `PlanVersionPanel` with diff view, source badges, restore button. 9 new tests.
**Commits:**

- `127ee27` feat(plans): add plan version history with auto-versioning
- `aea5ad1` feat(plans): add single version GET endpoint
  **Key files changed:**
- `drizzle/0002_powerful_jocasta.sql` (migration)
- `src/lib/db/schema.ts` (+planVersions table)
- `src/lib/services/plan-service.ts` (+102 lines)
- `src/lib/worker/session-plan-utils.ts`
- `src/app/api/plans/[id]/versions/route.ts` (GET/POST)
- `src/app/api/plans/[id]/versions/[version]/route.ts`
- `src/components/plans/plan-version-panel.tsx` (410 lines)
- `src/lib/services/__tests__/plan-version-service.test.ts` (9 tests)
- `src/lib/types.ts` (+PlanVersion types)
  **Issues/Notes:** Comprehensive delivery matching all requirements. TDD approach properly followed.

---

#### 9dd266b9 — Research: native worktree support per agent provider

**Requested:** Research each CLI's worktree/isolation support. Add "Isolated worktree" toggle to session creation UI.
**Delivered:** Research: Claude has native `--worktree`, Codex/Gemini do not. Implementation: `useWorktree` column, schema migration, service/API updates, UI toggle (Claude-only).
**Commits:**

- `cc46762` feat(sessions): add MCP selection and worktree toggle to session creation (shared with 14bc1b3c)
- `2986f76` chore: add .claude/worktrees/ to gitignore
  **Key files changed:**
- `src/lib/db/schema.ts` (+useWorktree column)
- `drizzle/0003_damp_micromacro.sql`
- `src/lib/services/session-service.ts`, API routes, spawn-opts-builder, claude-adapter
- `src/components/sessions/start-session-dialog.tsx`, `quick-launch-dialog.tsx`
- `.gitignore`
  **Issues/Notes:** Pragmatic choice to use Claude-native `--worktree` instead of provider-agnostic approach. Toggle correctly hidden for non-Claude agents.

---

#### 5bc68dd1 — Improve capability management UX and mechanism

**Requested:** Fix 5 UX problems: only "Run Prompt" preset, no clone, template variables undocumented, no preview, source field hidden.
**Delivered:** All 5 addressed: 4 presets per agent, clone button, variable docs panel, live preview toggle, source badges.
**Commits:**

- `2888dba` feat(capabilities): add template variable docs and live preview to dialog
- `02c1f31` feat(capabilities): add source badge and clone button to capability rows
- `b1df4b0` feat(capabilities): add Code Review, Implement Feature, Fix Bug presets
  **Key files changed:**
- `src/components/agents/add-capability-dialog.tsx` (+130 lines)
- `src/components/agents/capability-row.tsx` (+52 lines)
- `src/lib/discovery/presets.ts` (+96 lines)
  **Issues/Notes:** Clean delivery across 3 well-scoped commits. All 5 requirements met.

---

#### d4848bc9 — Add execution order / sequencing support for tasks

**Requested:** Add `executionOrder` field and `dependsOn` relation. Drag-and-drop reordering, dependency arrows, "Next up" indicator. API + MCP tools.
**Delivered:** Core execution order: nullable `execution_order` column, `setExecutionOrder()` bulk API, `listReadyTasks()`, MCP tools, numbered badge on cards, "Next up" glow indicator.
**Commits:**

- `6f384ba` feat(tasks): add execution order and sequencing support
- `35f57fa` feat(tasks): add execution order UI with next-up indicator
  **Key files changed:**
- `drizzle/0004_acoustic_kate_bishop.sql`
- `src/lib/db/schema.ts`, `src/lib/services/task-service.ts`
- `src/app/api/tasks/execution-order/route.ts`, `src/app/api/tasks/ready/route.ts`
- `src/lib/mcp/tools/task-tools.ts` (+2 MCP tools)
- `src/components/tasks/task-card.tsx`, `task-column.tsx`, `task-meta-panel.tsx`
  **Issues/Notes:** PARTIAL DELIVERY — three requirements not implemented:

1. **`dependsOn` relation** — not added to schema (ready filter uses execution order only)
2. **Drag-and-drop reordering** — not implemented (manual number input only)
3. **Dependency arrows** — not implemented

---

### Layer 3: Research

#### 4447ef8e — Research: GitHub Copilot CLI as a new agent provider

**Requested:** Evaluate adding GitHub Copilot CLI as a fourth agent provider.
**Delivered:** 233-line research doc covering availability, headless mode, ACP protocol, MCP integration, multi-model backend, auth, SDK options.
**Commits:**

- `7850ed9` refactor(cli): update summarization-providers.ts _(contains the research doc — mislabeled)_
- `f54461e` docs(research): GitHub Copilot CLI integration research _(contains test files — mislabeled)_
  **Key files changed:**
- `planning/copilot-cli-research.md` (233 lines)
  **Issues/Notes:** Commit messages are swapped — the doc is in a "refactor(cli)" commit; the "docs(research)" commit has test files. Traceability issue.

---

#### 506e5a54 — Research: Multi-layer persistent memory system for AI agents

**Requested:** Investigate multi-layer persistent memory architecture. 4-layer hierarchy, progressive disclosure, background automation, pattern detection.
**Delivered:** 886-line research doc covering theoretical foundations, 7 existing implementations, 4-layer design, progressive disclosure, background automation, MCP access, Agendo integration design with data model and phased roadmap.
**Commits:**

- `d261fad` docs(research): multi-layer persistent memory system analysis (854 lines)
- `228e302` docs(research): add emerging systems and expanded references (+35 lines)
  **Key files changed:**
- `planning/memory-system-research.md` (886 lines)
  **Issues/Notes:** Clean delivery. All requested areas covered. Goes beyond research into actionable Agendo integration design.

---

### Layer 4: Infrastructure

#### bff31038 — Build modular repo-sync agent

**Requested:** Build a reusable, modular agent that periodically syncs external repos into Agendo.
**Delivered:** Complete repo-sync service: types/interfaces, sync engine with manifest-based change detection, configurable target registry, CLI script, 12 unit tests, ai-session route refactor.
**Commits:**

- `4b20686` feat(repo-sync): add modular repo-sync service (1737 insertions — also contains entire plugin framework)
- `eb1f77c` feat(repo-sync): add repo-sync service, CLI script, and ai-session refactor (830 insertions)
  **Key files changed:**
- `src/lib/services/repo-sync/types.ts`, `sync-engine.ts`, `targets.ts`, `index.ts`
- `src/lib/services/repo-sync/__tests__/sync-engine.test.ts` (12 tests, 305 lines)
- `scripts/repo-sync.ts`
- `src/app/api/config/analyze/ai-session/route.ts`
  **Issues/Notes:** Significant scope creep — commit `4b20686` also contains the entire plugin architecture framework (1700+ lines) from task `341c44fd`. The two tasks' work is co-mingled in one commit.

---

#### 378e5c9d — Redesign settings/config page

**Requested:** Review and redesign settings/config page for simplicity and better UX.
**Delivered:** Unified `/settings` page with 3 tabs (Agents, MCP Servers, Config Files). Consolidated 3 sidebar nav items into single "Settings" entry. Card grids with inline quick-action toggles.
**Commits:**

- `0293431` feat(settings): unified settings page with card-based UI (882 insertions, 5 files)
  **Key files changed:**
- `src/app/(dashboard)/settings/page.tsx` (21 lines)
- `src/app/(dashboard)/settings/settings-client.tsx` (98 lines)
- `src/components/settings/agent-cards.tsx` (188 lines)
- `src/components/settings/mcp-server-cards.tsx` (574 lines)
- `src/components/layout/sidebar.tsx`
  **Issues/Notes:** Cleanest delivery of the entire batch. Single focused commit, exactly what was requested. Later modified by plugin commit to add Plugins tab.

---

#### 341c44fd — Design plugin architecture

**Requested:** Design plugin/extensibility framework for Agendo. Start with design doc.
**Delivered:** 419-line design doc plus full working implementation: plugin types, registry with auto-disable (10 errors/hour), loader, context, store, built-in repo-sync plugin, API routes, settings UI plugin cards, DB schema.
**Commits:**

- `4b20686` feat(repo-sync): add modular repo-sync service _(ALL plugin code committed under repo-sync's commit)_
  **Key files changed:**
- `planning/plugin-architecture.md` (419 lines)
- `src/lib/plugins/types.ts` (202 lines), `plugin-registry.ts` (237 lines), `plugin-loader.ts` (194 lines), `plugin-context.ts` (79 lines), `plugin-store.ts` (58 lines)
- `src/lib/plugins/builtin/repo-sync/index.ts` (224 lines)
- `src/components/settings/plugin-cards.tsx` (178 lines)
- `src/app/api/plugins/route.ts`, `src/app/api/plugins/[id]/route.ts`
- `src/lib/services/plugin-service.ts` (48 lines)
- `src/lib/db/schema.ts` (plugin table additions)
  **Issues/Notes:**

1. **No dedicated commit** — all code committed under repo-sync's `4b20686`. Git attribution impossible.
2. Agent went beyond "design" scope and built full implementation — useful but not requested.
3. Tightly coupled with repo-sync (first built-in plugin).

---

## Integration Gaps & Recommendations

### Critical — Fix Immediately

| Issue                         | Task     | Action Required                                                  |
| ----------------------------- | -------- | ---------------------------------------------------------------- |
| Type safety gap in builds     | e8b9789b | Add `pnpm typecheck &&` prefix to `build:all` in `package.json`  |
| Forked session UI bug unfixed | 97788b7c | Apply the one-line fix to `session-chat-view.tsx` and commit     |
| Codex model switching broken  | d495d3b7 | Implement `setDefaultModel` RPC in `codex-app-server-adapter.ts` |

### Important — Follow Up

| Issue                       | Task     | Action Required                                                        |
| --------------------------- | -------- | ---------------------------------------------------------------------- |
| MCP auto-include UX gap     | cc552916 | Apply DB fix + commit the "Auto-include" label changes                 |
| Dead commented-out code     | 19fcbb6e | Delete `enqueueSession` import and call from `session-fork-service.ts` |
| Full mode turn-dropping bug | 3e34686f | Create subtask with detailed diagnosis and fix plan                    |
| Missing dependsOn relations | d4848bc9 | Create follow-up task for task dependency system                       |
| Missing drag-and-drop       | d4848bc9 | Create follow-up task for DnD reordering                               |

### Process Improvements for Next Batch

1. **Enforce commit verification**: After agent says "committed", verify commit exists before marking task done
2. **One commit per task**: Prevent cross-task pollution — agents should scope commits to their task
3. **Commit message validation**: Auto-check that commit messages match the files they contain
4. **Investigation tasks need structure**: Require structured output format (root cause, recommendation, subtasks created) not free-form notes
5. **Progress note integrity**: Agent claims ("I committed X") should be verified against actual git state before task completion
