# Brainstorm Personas

## Goal

Add a provider-aware persona layer to brainstorm prompts without changing the existing
brainstorm room schema or protected session preamble files.

The design target is:

`role instructions` + `provider persona lens` = `effective brainstorm persona`

This keeps the current role system intact while making Claude, Codex, Gemini, and
Copilot contribute in ways that fit their observed strengths in Agendo.

## Evidence Base

This design is grounded in the current codebase and internal planning docs:

- `src/lib/worker/brainstorm-orchestrator.ts`
  `buildPreamble()` already composes brainstorm-specific prompt sections per participant.
  This is the correct injection point.
- `src/lib/worker/brainstorm-quality.ts`
  Quality scoring only inspects response text. Persona changes should remain prompt-only.
- `src/lib/worker/brainstorm-history.ts`
  History reconstruction is wave/text based. Persona changes must not alter event shape.
- `planning/research/architecture-v2-the-right-way.md`
  Documents protocol capability differences:
  Claude SDK is the richest, Codex app-server is the most interactive, Gemini/Copilot ACP
  are thinner integrations.
- `src/lib/worker/skills/agendo-workflow.md`
  Existing agent guidance already frames the providers as:
  Claude = reasoning/architecture, Codex = focused implementation, Gemini = research and
  alternative perspectives, Copilot = smaller execution-oriented help.

The persona layer therefore encodes collaboration tendencies that are already reflected
in the repo's architecture and agent guidance, rather than inventing new behavior.

## Provider Personas

### Claude

**Observed strengths**

- Best fit for long-form reasoning and architecture analysis.
- Richest integration in Agendo: SDK control, history, context usage, MCP management,
  subagents, hooks, and structured output.
- Existing repo guidance already positions Claude for complex reasoning and multi-file
  refactors.

**Brainstorm persona**

Claude should act as the participant who:

- surfaces assumptions that are still implicit
- connects local decisions to system-wide consequences
- reasons about invariants, failure modes, and maintainability
- helps the room converge into a coherent position instead of a bag of ideas

**Best role fit**

- Strongest: `architect`, `critic`
- Secondary: `pragmatist`
- Weaker but still useful: `optimist`

### Codex

**Observed strengths**

- Strongest protocol for interactive coding operations: `developerInstructions`,
  `skills/list`, `turn/steer`, `thread/rollback`, token usage, thread management.
- Existing repo guidance positions Codex for code generation and focused implementation.

**Brainstorm persona**

Codex should act as the participant who:

- translates ideas into code-level consequences
- spots implementation complexity, test gaps, and performance traps
- narrows discussion toward the smallest sound diff
- keeps proposals grounded in actual file/module/workflow changes

**Best role fit**

- Strongest: `pragmatist`, `critic`
- Secondary: `architect`
- Weaker but still useful: `optimist`

### Gemini

**Observed strengths**

- Existing repo guidance positions Gemini for research, analysis, and alternative
  perspectives.
- ACP integration is thinner than Claude/Codex, which suggests using Gemini less as the
  final synthesis lead and more as the broad-search / option-expansion participant.

**Brainstorm persona**

Gemini should act as the participant who:

- broadens the search space before the room converges too early
- compares multiple patterns, ecosystems, and tradeoffs
- introduces alternatives, analogies, and missing external constraints
- checks whether the room is overlooking a simpler or more standard approach

**Best role fit**

- Strongest: `optimist`, `critic`
- Secondary: `architect`
- Weaker but still useful: `pragmatist`

### Copilot

**Observed strengths**

- Current repo guidance positions Copilot for smaller focused tasks.
- ACP integration is lightweight, and Copilot research notes emphasize GitHub-native
  workflows, specialized agents, and quick execution support.

**Brainstorm persona**

Copilot should act as the participant who:

- reduces ambiguity into execution-ready steps
- highlights developer workflow and tooling friction
- favors familiar patterns, guardrails, and reviewability
- contributes concise, practical refinements rather than leading deep theory

**Best role fit**

- Strongest: `pragmatist`, `optimist`
- Secondary: `critic`
- Weakest: `architect`

## Phase Mapping

### Divergent Exploration

Primary contributors:

- Gemini: widens the option set and introduces external alternatives
- Claude: frames the problem space and identifies hidden system constraints
- Codex: tests whether ideas survive contact with the codebase
- Copilot: proposes quick wins and operational shortcuts

### Critique

Primary contributors:

- Claude: architectural inconsistency, edge cases, security, maintenance risk
- Codex: implementation complexity, test coverage gaps, performance traps
- Gemini: ecosystem tradeoffs, missed alternatives, missing context outside the current code
- Copilot: workflow friction, guardrails, and review ergonomics

### Convergence

Primary contributors:

- Claude: synthesizes the cleanest defensible decision
- Codex: trims scope to an implementable diff and concrete next steps
- Copilot: turns the outcome into checklists / low-friction execution steps
- Gemini: validates that the room did not collapse onto a narrow local optimum too early

## Injection Mechanism

### Where to inject

Inject provider persona context inside `BrainstormOrchestrator.buildPreamble()`.

Recommended placement:

1. `## Assigned Roles`
2. `## Your Role` (if any)
3. `## Your Provider Lens`
4. `## Discussion Brief`

Why this placement works:

- the role still defines the participant's job in the room
- the provider lens modifies how that job is executed
- the discussion brief remains separate from persona identity

### Prompt composition rule

Use composition, not schema expansion:

- keep `DEFAULT_ROLE_INSTRUCTIONS` unchanged as the generic role baseline
- keep `BrainstormConfig.roleInstructions` as `Record<string, string>`
- append provider-specific guidance at prompt build time

This preserves backward compatibility for existing brainstorm configs and tests.

### Scope of injected content

The provider lens should be:

- short enough to avoid drowning the task prompt
- specific enough to create differentiated behavior
- phrased as emphasis guidance, not as a hard constraint

Recommended structure:

- 1 short identity sentence
- 3 focused bullets for what to emphasize
- 1 optional role-specific paragraph when a known role is assigned

## Implementation Decision

Implement provider personas as source-controlled TypeScript definitions plus shipped
markdown skill files.

### Source definitions

Create `src/lib/worker/brainstorm-personas.ts` with:

- persona metadata by provider
- phase guidance
- role-specific lens overrides
- a helper that returns prompt text for `buildPreamble()`

### Shipped skill files

Create provider persona reference skills under `src/lib/worker/skills/` so anyone who
installs Agendo gets the same persona guidance available locally.

These skill files are for distribution and discoverability. The brainstorm prompt should
still read from source-controlled TypeScript definitions so runtime behavior does not
depend on external filesystem state.

## Explicit Non-Goals

- Do not change `roleInstructions` schema in this iteration.
- Do not change `AUTO_ROLE_ASSIGNMENTS` in this iteration.
- Do not touch `session-preambles.ts`, `session-tools.ts`, `agendo-workflow.md`, or `SKILL.md`.
- Do not make quality/history logic persona-aware yet. Prompt injection is sufficient for
  the first iteration.
