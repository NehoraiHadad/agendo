# Native Skill Injection for CLI Agents — Research Document

> Task: 12e4951d-3d2f-4002-97c7-6e125ba372d0
> Date: 2026-03-16
> Status: Phase 1 Research + Phase 2 Design

## Executive Summary

Agendo currently injects context into agent sessions via two mechanisms:

1. **MCP server injection** — per-agent native mechanism (SDK mcpServers, ACP session/new, Codex config/batchWrite)
2. **Preamble prepending** — text prepended to the user's first message (or Codex `developerInstructions`)

Neither mechanism properly leverages each CLI's native skill/instruction system. This document maps out the native capabilities and designs an injection layer.

---

## Phase 1: Per-CLI Research

### 1. Claude Code

**Current Agendo injection:**

- MCP: SDK `Options.mcpServers` (native SDK format) — `build-sdk-options.ts` line 76
- Preamble: Prepended to user prompt in `session-runner.ts` line 224
- `appendSystemPrompt` exists in `SpawnOpts` (line 65) and is wired to SDK's `systemPrompt: { type: 'preset', preset: 'claude_code', append: '...' }` — but **NOT USED** currently
- `settingSources: ['user', 'project', 'local']` loads `~/.claude/` settings, hooks, commands

**Native skill mechanisms:**

| Mechanism                | Format                           | Scope                       | Available in SDK?                   | Best for                                     |
| ------------------------ | -------------------------------- | --------------------------- | ----------------------------------- | -------------------------------------------- |
| `CLAUDE.md`              | Markdown                         | Project root / `~/.claude/` | Yes (via settingSources)            | Project-specific context, coding conventions |
| `--append-system-prompt` | Text string                      | Session                     | Yes (`systemPrompt.append`)         | Session-level instructions, role definitions |
| Slash commands           | `~/.claude/commands/*.md`        | Global/project              | Yes (via settingSources)            | On-demand skill invocation                   |
| Skills (plugins)         | `~/.claude/plugins/.../SKILL.md` | Global                      | Interactive only (not SDK)          | Complex domain knowledge                     |
| Hooks                    | `~/.claude/hooks/`               | Global/project              | Yes (`settingSources` + `sdkHooks`) | Pre/post tool actions                        |
| SDK Agents               | `Options.agents`                 | Session                     | Yes                                 | Subagent definitions with scoped skills      |

**Recommended injection strategy:**

1. **`appendSystemPrompt`** — Use for the agendo workflow skill (always-on context). This is the correct semantic: it's system-level instructions, not user input.
2. **`CLAUDE.md`** — Already loaded via `settingSources`. No action needed for project context.
3. **Slash commands** — Not useful for automated injection (requires user to type `/command`).
4. **SDK `agents`** — Could be used to define specialized agent modes (e.g., an "agendo-task-agent" with specific skills). Future enhancement.

**Key insight:** Claude is the only agent that distinguishes system prompt from user prompt at the SDK level. The `appendSystemPrompt` mechanism is ideal — it keeps skill content separate from user messages and survives conversation compaction.

---

### 2. Codex CLI (OpenAI)

**Current Agendo injection:**

- MCP: `config/batchWrite` JSON-RPC before `thread/start` — `codex-app-server-adapter.ts` line 310-326
- Preamble: `developerInstructions` field in `thread/start` — line 362-364
- Skills discovery: `fetchAndEmitSkills()` scans `~/.agents/skills/` and `{cwd}/.codex/skills/` — line 399-486

**Native skill mechanisms:**

| Mechanism                                           | Format                       | Scope                                                           | Available in app-server? | Best for                                                                                   |
| --------------------------------------------------- | ---------------------------- | --------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `developerInstructions`                             | Text string (role=developer) | Thread                                                          | Yes (thread/start)       | Additive context alongside built-in prompt                                                 |
| `baseInstructions`                                  | Text string                  | Thread                                                          | Yes (thread/start)       | REPLACES built-in system prompt entirely (avoid!)                                          |
| SKILL.md files                                      | Markdown + YAML frontmatter  | `~/.codex/skills/`, `~/.agents/skills/`, `{cwd}/.codex/skills/` | Yes (auto-discovered)    | Progressive disclosure: name+desc upfront, full body on-demand                             |
| `skills/list` RPC                                   | JSON-RPC method              | Session                                                         | Yes                      | Enumerating available skills                                                               |
| `config.toml`                                       | TOML                         | `~/.codex/`                                                     | Yes (read on startup)    | `developer_instructions`, `model_instructions_file`, skill overrides                       |
| AGENTS.md                                           | Markdown                     | Git root → cwd walk                                             | Yes (auto-loaded)        | Project instructions (equivalent to CLAUDE.md). Fallback: `project_doc_fallback_filenames` |
| `collaborationMode.settings.developer_instructions` | Text string                  | Per-turn                                                        | Yes (turn/start)         | Sub-agent role assignment in orchestration mode                                            |

**SKILL.md format (confirmed from Codex system skills):**

```yaml
---
name: skill-name
description: What this skill does
metadata:
  short-description: Brief description
  tags: tag1, tag2
---
# Skill Name

Markdown content with instructions, examples, rules...
```

**Optional subdirectories:**

- `agents/openai.yaml` — UI metadata
- `scripts/` — Executable scripts
- `references/` — Supporting docs
- `assets/` — Templates, resources

**Recommended injection strategy:**

1. **`developerInstructions`** — Use for the agendo workflow preamble (already working). This is equivalent to Claude's `appendSystemPrompt`.
2. **SKILL.md files** — Write Agendo skills to `~/.agents/skills/agendo/SKILL.md` and `~/.agents/skills/artifact-design/SKILL.md`. Codex auto-discovers and loads these based on relevance. This is the proper native path.
3. **`skills/list` RPC** — Already implemented in adapter for discovery. No change needed.

**Key insight (confirmed via web docs):** Codex has the most mature skill system. `developerInstructions` is a `role=developer` message (priority: system > **developer** > user) — our current approach is correct. Skills use progressive disclosure: only ~100 words (name+description) upfront, full body loaded on-demand by the model. AGENTS.md is auto-loaded from git root → cwd (equivalent to CLAUDE.md). Can configure `project_doc_fallback_filenames = ["CLAUDE.md"]` in config.toml.

---

### 3. Gemini CLI (Google)

**Current Agendo injection:**

- MCP: ACP `session/new` with `mcpServers` array — `gemini-acp-transport.ts` line 173
- Preamble: Prepended to user prompt via ACP `session/prompt` — via `session-runner.ts` line 224
- TOML commands: Scanned from `~/.gemini/commands/` — `gemini-adapter.ts` line 63-92

**Native skill mechanisms (web research confirmed 2026-03-16):**

| Mechanism          | Format                                               | Scope                                                          | Available in ACP?              | Best for                                               |
| ------------------ | ---------------------------------------------------- | -------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `GEMINI.md`        | Markdown                                             | 3-tier: global `~/.gemini/`, workspace `.gemini/`, JIT per-dir | Yes (auto-loaded)              | Project-specific context (ADDITIVE to built-in prompt) |
| Agent Skills       | SKILL.md in `~/.gemini/skills/` or `.gemini/skills/` | Global/project                                                 | No (filesystem only)           | On-demand domain knowledge (model-activated)           |
| Custom commands    | TOML in `~/.gemini/commands/`                        | Global/project                                                 | Yes (merged with ACP commands) | User-triggered actions                                 |
| Extensions         | `~/.gemini/extensions/` + JSON manifest              | Global                                                         | Yes                            | MCP server + context bundles                           |
| `GEMINI_SYSTEM_MD` | Env var → file path                                  | Session                                                        | Via env                        | Full system prompt REPLACEMENT (heavy)                 |
| `settings.json`    | JSON                                                 | `~/.gemini/`                                                   | Yes                            | Config only (no system prompt field)                   |

**GEMINI.md format (confirmed via web docs):**

- Plain markdown, supports `@path/to/file.md` import syntax
- 3-tier loading: global `~/.gemini/GEMINI.md` → workspace `.gemini/GEMINI.md` → JIT per-dir
- **ADDITIVE** to built-in system prompt (unlike `GEMINI_SYSTEM_MD` which replaces it)
- Filename configurable in `settings.json` → `context.fileName` (can be `["AGENTS.md", "CONTEXT.md", "GEMINI.md"]`)

**Agent Skills (NEW — same format as Codex):**

```yaml
---
name: code-reviewer
description: Use this skill to review code
---
# Code Reviewer
Instructions in Markdown...
```

- Discovery: `.gemini/skills/`, `~/.gemini/skills/`, `.agents/skills/`, `~/.agents/skills/`
- Activated by model via internal `activate_skill` tool — NOT guaranteed per session
- Token-efficient (loaded on-demand, not upfront)
- Management: `/skills list`, `/skills enable`, `/skills disable`

**`GEMINI_SYSTEM_MD` env var:**

- `GEMINI_SYSTEM_MD=true` → reads `./.gemini/system.md`
- `GEMINI_SYSTEM_MD=/path/to/file.md` → reads arbitrary file
- **Full replacement** of built-in system prompt (too destructive for skill injection)
- Supports variable substitution: `${AgentSkills}`, `${SubAgents}`, `${AvailableTools}`

**ACP protocol limitations (confirmed):**

- `session/new` accepts only `cwd`, `mcpServers`, `_meta` — NO system prompt field
- Prompt preamble via first `session/prompt` is the only ACP-supported injection method

**Recommended injection strategy:**

1. **Prompt prepending** — Primary method for all session-specific context. Only guaranteed ACP method.
2. **GEMINI.md** — Good supplement for persistent project-level context (auto-loaded, additive)
3. **Agent Skills** — Future enhancement: write SKILL.md to `~/.gemini/skills/agendo/` for token-efficient on-demand activation (not guaranteed to fire though)
4. **`GEMINI_SYSTEM_MD`** — Avoid (replaces entire built-in prompt)

**Key insight:** Gemini now has the same SKILL.md format as Codex via the shared Agent Skills standard. However, skill activation is model-dependent, so for Agendo's guaranteed injection, prompt preamble remains the correct approach. GEMINI.md is additive and reliable for persistent context.

---

### 4. GitHub Copilot CLI

**Current Agendo injection:**

- MCP: `--additional-mcp-config` JSON flag — `copilot-adapter.ts` line 84
- Preamble: Prepended to user prompt via ACP `session/prompt`

**Native mechanisms (web research confirmed 2026-03-16):**

| Mechanism                            | Format                        | Scope                         | Available?        | Best for                                                   |
| ------------------------------------ | ----------------------------- | ----------------------------- | ----------------- | ---------------------------------------------------------- |
| `AGENTS.md`                          | Markdown                      | Project root / nested subdirs | Yes (auto-loaded) | Project instructions (shared standard with Codex/OpenCode) |
| `.github/copilot-instructions.md`    | Markdown                      | Repository                    | Yes (auto-loaded) | Repo-wide instructions                                     |
| `~/.copilot/copilot-instructions.md` | Markdown                      | Global                        | Yes               | User-global instructions                                   |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`   | Env var → dirs with AGENTS.md | Session                       | Yes               | **Programmatic injection path**                            |
| Agent Skills                         | SKILL.md in `.github/skills/` | Project                       | Yes               | On-demand domain knowledge                                 |
| Custom agents                        | Agent profile markdown files  | Project                       | Yes               | Specialized sub-agent definitions                          |
| ACP session/prompt                   | Text                          | Session                       | Yes               | User-level prompt (not system)                             |
| `--additional-mcp-config`            | JSON flag                     | Session                       | Yes               | MCP server injection                                       |

**No `--system-prompt` flag** — open feature requests: #232, #399, #1023.

**Best programmatic injection path:**
`COPILOT_CUSTOM_INSTRUCTIONS_DIRS` env var — write a temp dir with `AGENTS.md` containing Agendo skill content, pass dir path as env var at spawn time.

**Recommended injection strategy:**

1. **Prompt prepending** — Current approach, reliable and simple.
2. **Future enhancement:** Use `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` for system-level skill injection (requires temp dir + cleanup).

**Key insight:** Copilot now supports AGENTS.md and Agent Skills (same open standard as Codex/Gemini). The `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` env var is a viable programmatic injection path for future upgrade.

---

### 5. OpenCode

**Current Agendo injection:**

- MCP: `OPENCODE_CONFIG_CONTENT` env var + ACP `session/new` — `opencode-adapter.ts` line 33-80
- Preamble: Prepended to user prompt via ACP `session/prompt`

**Native mechanisms (web research confirmed 2026-03-16):**

| Mechanism                 | Format                                                          | Scope                                                 | Available?        | Best for                                               |
| ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- | ----------------- | ------------------------------------------------------ |
| `AGENTS.md`               | Markdown                                                        | Project root / nested subdirs / `~/.config/opencode/` | Yes (auto-loaded) | Project instructions                                   |
| `instructions` in config  | Array of file paths/globs/URLs                                  | Config                                                | Yes               | **Programmatic injection via OPENCODE_CONFIG_CONTENT** |
| `OPENCODE_CONFIG_CONTENT` | Full JSON config as env var                                     | Session                                               | Yes               | Permission + MCP + instruction injection               |
| `OPENCODE_CONFIG`         | Env var → config file path                                      | Session                                               | Yes               | Point to temp config file                              |
| `OPENCODE_CONFIG_DIR`     | Env var → config dir                                            | Session                                               | Yes               | Full config override directory                         |
| Custom agents             | Markdown in `.opencode/agents/` or `~/.config/opencode/agents/` | Project/global                                        | Yes               | Agent mode definitions                                 |
| ACP session/prompt        | Text                                                            | Session                                               | Yes               | User-level prompt                                      |

**Best programmatic injection path:**
`OPENCODE_CONFIG_CONTENT` already includes `"instructions": ["/path/to/file.md"]` field — write a temp file with Agendo skill content and reference it.

**Recommended injection strategy:**

1. **Prompt prepending** — Current approach, simple and reliable.
2. **Future enhancement:** Add `instructions` array to `OPENCODE_CONFIG_CONTENT` pointing to temp skill files for system-level injection.

**Key insight:** OpenCode has the richest injection surface of any CLI (config env vars, AGENTS.md, custom agents). The `instructions` field in `OPENCODE_CONFIG_CONTENT` is a strong future upgrade path.

---

## Summary: Injection Capabilities Matrix

| Agent        | System Prompt                 | Native Skills                  | Project File                                 | MCP Injection                   | Future Upgrade Path                        |
| ------------ | ----------------------------- | ------------------------------ | -------------------------------------------- | ------------------------------- | ------------------------------------------ |
| **Claude**   | `appendSystemPrompt` (SDK)    | SKILL.md (plugins)             | CLAUDE.md                                    | SDK `mcpServers`                | Already optimal                            |
| **Codex**    | `developerInstructions` (RPC) | SKILL.md (`~/.agents/skills/`) | AGENTS.md                                    | `config/batchWrite` RPC         | Already optimal                            |
| **Gemini**   | Prompt prepend                | SKILL.md (`~/.gemini/skills/`) | GEMINI.md                                    | ACP `session/new`               | GEMINI.md file injection                   |
| **Copilot**  | Prompt prepend                | SKILL.md (`.github/skills/`)   | AGENTS.md, `.github/copilot-instructions.md` | `--additional-mcp-config`       | `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` env var |
| **OpenCode** | Prompt prepend                | Custom agents                  | AGENTS.md                                    | `OPENCODE_CONFIG_CONTENT` + ACP | `instructions` array in config             |

---

## Phase 2: Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Skills Registry (src/lib/worker/skills/)            │
│                                                      │
│  skills/                                             │
│    agendo-workflow.md    — always injected            │
│    artifact-design.md   — injected when MCP enabled  │
│    (future skills...)                                │
│                                                      │
│  skill-injector.ts      — per-agent injection logic  │
│  skill-registry.ts      — loads and caches skills    │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
    ┌─────▼──┐   ┌────▼───┐  ┌────▼───┐
    │ Claude │   │ Codex  │  │ Gemini │  (+ Copilot, OpenCode)
    │        │   │        │  │        │
    │append  │   │SKILL.md│  │GEMINI  │
    │System  │   │files + │  │.md +   │
    │Prompt  │   │devInstr│  │prompt  │
    └────────┘   └────────┘  └────────┘
```

### Skill Files

Two skill files to start:

#### 1. `agendo-workflow.md` (always injected)

Content: Expanded version of `planning/agendo-workflow-skill.md` + current execution/planning preamble content. Includes:

- Task lifecycle (get_my_task → update_task → add_progress_note → done)
- MCP tool reference table
- Missing tool creation guidance
- Planning mode guidance (create_task, list_tasks, start_agent_session)

#### 2. `artifact-design.md` (injected when MCP enabled)

Content: Current `DESIGN_GUIDELINES` from `artifact-tools.ts` lines 22-56. Includes:

- Context selection (agendo-native vs project-native)
- Design principles (typography, color, motion, layout, atmosphere)
- Anti-patterns
- Technical constraints (DOCTYPE, inline CSS/JS, CDN list)

### Per-Agent Injection Strategy

```typescript
// src/lib/worker/skills/skill-injector.ts

interface SkillInjection {
  /** Text to append to Claude's system prompt */
  appendSystemPrompt?: string;
  /** Text for Codex's developerInstructions */
  developerInstructions?: string;
  /** Text to prepend to user prompt (fallback for ACP agents) */
  promptPreamble?: string;
  /** Filesystem skill files to write (Codex SKILL.md) */
  skillFiles?: Array<{ path: string; content: string }>;
  /** GEMINI.md content to write */
  geminiMd?: string;
}

function buildSkillInjection(
  binaryName: string,
  skills: SkillContent[],
  sessionContext: { taskId?: string; projectName: string; hasMcp: boolean },
): SkillInjection;
```

#### Claude Strategy

1. **Static skills** (agendo-workflow, artifact-design) → `appendSystemPrompt`
2. **Dynamic context** (task ID, progress notes) → prompt prepend (stays in user message)
3. Benefit: Skills survive conversation compaction, don't pollute user message history

#### Codex Strategy

1. **Static skills** → Write `SKILL.md` files to `~/.agents/skills/agendo/SKILL.md` and `~/.agents/skills/artifact-design/SKILL.md` at startup
2. **Dynamic context** → `developerInstructions` in `thread/start`
3. Codex auto-discovers and injects skills based on relevance — no adapter changes needed

#### Gemini Strategy

1. **Static skills** → Write combined content to `{cwd}/.gemini/GEMINI.md` (per-session, per-project)
2. **Dynamic context** → Prompt prepend
3. Caution: Don't overwrite user's existing GEMINI.md — merge or use a temp directory

#### Copilot / OpenCode Strategy

1. **All content** → Prompt prepend (only option)
2. Skills + dynamic context combined into a single prompt prefix

### Session Runner Changes

```
session-runner.ts (current):
  1. Build preamble text
  2. Prepend to user prompt (or set codexDeveloperInstructions)
  3. Start session

session-runner.ts (proposed):
  1. Load skill registry
  2. Determine which skills to inject (always: agendo-workflow; if MCP: artifact-design)
  3. Call buildSkillInjection(binaryName, skills, context)
  4. Apply injection:
     - Claude: set appendSystemPrompt on SpawnOpts
     - Codex: write SKILL.md files + set developerInstructions
     - Gemini: write GEMINI.md + set prompt preamble
     - Copilot/OpenCode: set prompt preamble
  5. Dynamic context (task ID, resume notes) still prepended to user prompt
  6. Start session
```

### Migration Plan

1. **Phase 3a: Create skill files**
   - `src/lib/worker/skills/agendo-workflow.md` — expanded from current preambles
   - `src/lib/worker/skills/artifact-design.md` — extracted from `artifact-tools.ts`
   - `src/lib/worker/skills/skill-registry.ts` — loads and caches skill content
   - `src/lib/worker/skills/skill-injector.ts` — per-agent injection logic

2. **Phase 3b: Wire into session-runner.ts**
   - Import `buildSkillInjection`
   - Apply injection before session start
   - Keep dynamic context (task ID, resume) in prompt prepend
   - Set `appendSystemPrompt` on SpawnOpts for Claude

3. **Phase 3c: Write Codex SKILL.md files**
   - On worker startup, write skill files to `~/.agents/skills/agendo/` and `~/.agents/skills/artifact-design/`
   - Idempotent: overwrite if content changed, skip if unchanged

4. **Phase 3d: Handle Gemini GEMINI.md**
   - Write per-project skill content to project's GEMINI.md
   - Need strategy for not clobbering user content (merge or use marker comments)

5. **Phase 3e: Remove `get_artifact_guidelines` MCP tool**
   - After skill injection is working, remove the tool from `artifact-tools.ts`
   - Update `render_artifact` description to remove "call get_artifact_guidelines first"

### Open Questions

1. **Gemini GEMINI.md clobbering** — If the user has their own GEMINI.md, we can't overwrite it. Options:
   - Use `<!-- AGENDO:START -->...<!-- AGENDO:END -->` markers to inject/update a section
   - Write to a temp directory and set `cwd` to that
   - Accept that Gemini gets skills via prompt prepend only (simplest)

2. **Codex SKILL.md persistence** — Should we write SKILL.md files once at worker startup, or per-session? Worker startup is simpler but skill content can't be session-specific.

3. **Skill versioning** — When skill content changes (code deploy), how to ensure Codex/Gemini pick up the new version? Codex re-scans on each thread/start. Gemini re-reads GEMINI.md on session start.

4. **get_artifact_guidelines removal** — The current MCP tool is "lazy" (only loaded when agent needs it). Skill injection is "eager" (always loaded). This increases token cost for sessions that never create artifacts. Trade-off: simpler architecture vs. token efficiency.
   - Mitigation: Make artifact-design skill injection conditional on session type or a flag.

---

## Appendix A: Current Preamble Content (for reference)

### Execution Preamble (task sessions)

```
[Agendo Context: task_id=X, project=Y]
Agendo MCP tools are available. Start by calling get_my_task...
If you encounter something you cannot do because an MCP tool is missing...
---
```

### Planning Preamble (conversations)

```
[Agendo Context: project=Y, mode=planning]
Agendo MCP tools are available. You are in a planning conversation.
- create_task / create_subtask — turn plan steps into actionable tasks
- list_tasks / get_task — inspect existing tasks and their status
- list_projects — list all projects
- start_agent_session — spawn an agent on a task when ready to execute
---
```

### Support Preamble (UI navigation)

```
[SYSTEM INSTRUCTIONS — YOU MUST FOLLOW THESE EXACTLY]
You are the Agendo app support assistant...
(Full UI navigation map, guide markers, bug reporting)
```

### Artifact Design Guidelines (MCP tool response)

```
# Artifact Design Guidelines
## Context — choose before writing any code
AGENDO-NATIVE: Match Agendo's dark aesthetic...
PROJECT-NATIVE: Match the project's own design system...
## Design Principles (7 rules)
## Technical constraints
```

## Appendix B: File Paths

| Current Location                                       | Purpose          | New Location                                                      |
| ------------------------------------------------------ | ---------------- | ----------------------------------------------------------------- |
| `session-preambles.ts` → `generateExecutionPreamble()` | Task context     | Split: static → `agendo-workflow.md`, dynamic → stays in preamble |
| `session-preambles.ts` → `generatePlanningPreamble()`  | Planning context | Split: static → `agendo-workflow.md`, dynamic → stays in preamble |
| `session-preambles.ts` → `generateSupportPreamble()`   | Support UI       | Stays as-is (special purpose, not a reusable skill)               |
| `artifact-tools.ts` → `DESIGN_GUIDELINES`              | Artifact design  | Move to `artifact-design.md` skill                                |
| `planning/agendo-workflow-skill.md`                    | Workflow guide   | Merge into `agendo-workflow.md` skill                             |
