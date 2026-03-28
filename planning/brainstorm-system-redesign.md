# Brainstorm System Redesign Plan

> Status: Draft
> Date: 2026-03-27
> Scope: Both the standalone Claude Code skill AND the Agendo brainstorm rooms system

---

## Problem Statement

The brainstorm system has two layers — a standalone Claude Code skill (`~/.claude/skills/brainstorm/SKILL.md`) and the Agendo brainstorm rooms infrastructure (`brainstorm-orchestrator.ts`). Both have structural issues:

### Current Issues

| #   | Problem                                                                                                                                                                                                                       | Where  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | **Personas are provider-based, not role-based**. `brainstorm-persona-claude` describes how Claude thinks, not what a critic does. The role system (`role-templates.ts`) is separate and disconnected from the persona skills. | Both   |
| 2   | **No protocol skill**. Participants don't understand the brainstorm system — rules are injected ad-hoc in the preamble. There's no reusable "how brainstorming works" knowledge.                                              | Both   |
| 3   | **`[PASS]` is fragile**. Turn completion relies on text parsing (`rawResponse.toLowerCase().startsWith('[pass]')`) — agents can format it wrong, wrap it in markdown, or forget entirely.                                     | Agendo |
| 4   | **No leader concept**. All participants are equal. Nobody is designated to synthesize, break ties, or take action.                                                                                                            | Both   |
| 5   | **Standalone skill is hardcoded to 2 participants**. Gemini + Codex only, no model choice, no dynamic participants.                                                                                                           | Skill  |
| 6   | **No mid-session model selection**. Model is set at participant creation and can't be chosen per-role.                                                                                                                        | Agendo |
| 7   | **Persona skills are never loaded by agents**. They exist on disk but aren't attached to spawned sessions.                                                                                                                    | Agendo |
| 8   | **Provider personas are duplicated**. Same content in `.md` skill files AND hardcoded in `brainstorm-personas.ts`.                                                                                                            | Agendo |

---

## Design Decisions

### D1: Role-Based Persona Skills (not provider-based)

**Current**: `brainstorm-persona-claude`, `brainstorm-persona-codex`, etc.
**New**: `brainstorm-role-critic`, `brainstorm-role-optimist`, `brainstorm-role-pragmatist`, `brainstorm-role-architect`, `brainstorm-role-wildcard`

Each skill defines the _behavioral stance_ of a role, independent of which AI model plays it. The provider lens becomes a lightweight modifier (a few sentences), not a full persona.

**Rationale**: A Gemini playing the critic role should behave like a critic, not like "Gemini with critic flavor". The role IS the persona. The provider just tints the approach.

### D2: Protocol Skill — "How Brainstorming Works"

A new `brainstorm-protocol` skill that every participant loads. It explains:

- Wave mechanics, turn structure, response expectations
- How to signal pass/done/block via MCP (not text parsing)
- The leader's role and when to defer to them
- Quality expectations (no empty agreement, no scope inflation)

This replaces the ad-hoc "Discussion Rules" section currently baked into `buildPreamble()`.

### D3: Leader Designation

One participant is the **leader**. The leader:

- Synthesizes at the end (replaces the separate synthesis session)
- Breaks ties on disagreements
- Is the one who actually executes actions after the brainstorm
- Can steer the discussion topic between waves

Default priority: Claude Code > Codex > Gemini > Copilot (configurable).

**This is a guideline, not a gate** — other participants can still propose actions and ideas. The leader is simply the designated executor and tiebreaker.

### D4: MCP-Based Turn Signaling (replace `[PASS]`)

New MCP tools for brainstorm participants:

| Tool                   | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `brainstorm_signal`    | Signal turn state: `done`, `pass`, `block` with optional reason |
| `brainstorm_get_state` | Get current wave, participants, who has responded, room status  |

**Why MCP over text parsing?**

- Structured, typed, unambiguous — no regex fragility
- Works identically across all agent CLIs (Claude, Codex, Gemini, Copilot all support MCP)
- Can carry metadata (reason for passing, blocking issue, confidence level)
- Orchestrator gets an instant signal instead of waiting for `awaiting_input` + text scan

**Backward compatibility**: `[PASS]` text detection remains as a fallback for agents that don't call the MCP tool. The MCP signal takes priority when both arrive.

### D5: Per-Participant Model Selection

The `model` field already exists on `brainstorm_participants` in the DB schema. What's missing:

- UI for choosing model when adding a participant
- Passing the model to the session creation
- Model discovery per agent type (already researched — see MEMORY.md)

---

## Architecture

### Skill Hierarchy

```
brainstorm-protocol          (always loaded — system rules, wave mechanics, MCP tools)
  +-- brainstorm-role-critic     (loaded for critic participants)
  +-- brainstorm-role-optimist   (loaded for optimist participants)
  +-- brainstorm-role-pragmatist (loaded for pragmatist participants)
  +-- brainstorm-role-architect  (loaded for architect participants)
  +-- brainstorm-role-wildcard   (loaded for wildcard/custom participants)
```

Provider lens is NOT a separate skill — it's 3-4 sentences injected into the preamble (from `brainstorm-personas.ts`, simplified).

### MCP Brainstorm Signal Flow

```
Agent calls mcp__agendo__brainstorm_signal({ signal: 'pass', reason: 'I agree with critic' })
  → MCP server → POST /api/brainstorms/signal
  → API extracts roomId from session's linked brainstorm participant
  → POST :4102/brainstorms/:roomId/signal (Worker HTTP)
  → Orchestrator receives structured signal
  → Updates participant state immediately (no text parsing needed)
  → Emits participant:status event
  → checkWaveComplete()
```

### Leader Selection

```typescript
const LEADER_PRIORITY: Record<Provider, number> = {
  anthropic: 1, // Claude Code — highest priority
  openai: 2, // Codex
  google: 3, // Gemini
  github: 4, // Copilot
};
```

Leader is determined at room creation:

1. If explicitly set in config → use that
2. Otherwise → sort participants by provider priority, first wins
3. Stored as `leaderId` on `brainstorm_rooms` (new column)

The leader's preamble gets an additional section explaining their responsibility. Non-leaders get a note about who the leader is and to defer execution decisions to them.

---

## Implementation Plan

### Phase 1: Role-Based Persona Skills (skill files only — no orchestrator changes)

**Goal**: Replace provider-based personas with role-based ones.

#### 1.1 Create new role skill files

New files in `src/lib/worker/skills/`:

- `brainstorm-role-critic.md`
- `brainstorm-role-optimist.md`
- `brainstorm-role-pragmatist.md`
- `brainstorm-role-architect.md`
- `brainstorm-role-wildcard.md`

Each file defines the role's behavioral stance across all brainstorm phases:

```markdown
---
name: brainstorm-role-critic
description: |
  Brainstorm role persona for the Critic. Loaded when a brainstorm participant
  is assigned the critic role. Defines stance, phase behavior, and success criteria.
---

# Critic Role

## Your Stance

You are the designated CRITIC. Your job is to protect the team from bad decisions
by finding weaknesses others miss.

## By Phase

### Divergent Exploration

- Challenge assumptions made without evidence
- Ask "what breaks if..." for every proposal
- Identify implicit dependencies

### Critique

- This is YOUR phase — be thorough and specific
- Find edge cases, failure modes, scalability walls
- Push back on scope creep and gold-plating
- Reference specific code paths, not abstract concerns

### Convergence

- Verify the final decision addresses the weaknesses you raised
- Name residual risks the team is accepting
- Confirm you're satisfied or explicitly dissent

## Success Criteria

A good critic turn: identifies a specific weakness with evidence, not just "this seems risky".
A bad critic turn: generic concern without reference to the codebase or problem.
```

Similar structure for optimist, pragmatist, architect, wildcard.

#### 1.2 Create the protocol skill

New file: `brainstorm-protocol.md`

```markdown
---
name: brainstorm-protocol
description: |
  Core brainstorm protocol skill. Always loaded for brainstorm participants.
  Explains wave mechanics, turn structure, MCP signaling, leader concept,
  and quality expectations.
---

# Brainstorm Protocol

## How This Works

You are a participant in a structured multi-agent brainstorm. The discussion
proceeds in waves. Each wave, you receive all other participants' responses
from the previous wave and must contribute your perspective.

## Wave Mechanics

- **Wave 0**: You receive the topic. Explore the codebase if needed (extra time).
- **Waves 1+**: You receive a bundle of all non-pass responses from the previous wave.
- Each wave has a time limit. Respond within it or you'll be timed out.

## Signaling (MCP Tools)

Use these MCP tools to signal your state — do NOT rely on text conventions:

- `brainstorm_signal({ signal: 'pass', reason: '...' })` — You agree with the
  current direction and have nothing substantial to add. Include a brief reason.
- `brainstorm_signal({ signal: 'done' })` — Your response is complete (implicit
  if you just respond normally).
- `brainstorm_signal({ signal: 'block', reason: '...' })` — You have a critical
  objection that must be addressed before proceeding.
- `brainstorm_get_state()` — Check current wave, who has responded, room status.

**Fallback**: If MCP tools are unavailable, start your response with `[PASS]`
to signal a pass.

## The Leader

One participant is designated the LEADER (usually Claude Code). The leader:

- Synthesizes the final recommendation
- Breaks ties on disagreements
- Is the primary executor of any resulting actions
- Other participants should address disagreements TO the leader

This is a guideline — everyone contributes ideas equally. The leader's
special role is in decision-making and execution, not in having more say.

## Quality Rules

1. Reference specific files and code paths — no hand-waving
2. Build on others' points — don't repeat what's been said
3. Disagree constructively with evidence
4. If you agree with everything, PASS — don't pad with agreement
5. Stay within scope — flag scope creep, don't contribute to it
```

#### 1.3 Register new skills, deprecate old ones

Update `skill-registry.ts`:

- Add 6 new skills: `brainstorm-protocol`, `brainstorm-role-{critic,optimist,pragmatist,architect,wildcard}`
- Keep old `brainstorm-persona-*` files temporarily (mark deprecated in description)
- Update `install-skills.ts` to handle the new entries

#### 1.4 Simplify `brainstorm-personas.ts`

Reduce the `PERSONAS` map to just provider tint — 2-3 sentences per provider, not a full persona definition. Remove `phaseLens` and `roleLens`. The role skill carries the behavioral weight now.

```typescript
const PROVIDER_TINTS: Record<Provider, { label: string; tint: string }> = {
  anthropic: {
    label: 'Claude',
    tint: 'You tend toward deep reasoning, architectural consistency, and surfacing hidden assumptions.',
  },
  openai: {
    label: 'Codex',
    tint: 'You tend toward implementation realism, code-level consequences, and the smallest robust change.',
  },
  google: {
    label: 'Gemini',
    tint: 'You tend toward breadth, alternative approaches, and ecosystem context others may miss.',
  },
  github: {
    label: 'Copilot',
    tint: 'You tend toward execution clarity, developer workflow, and practical guardrails.',
  },
};
```

**Files changed**: `brainstorm-personas.ts`, `skill-registry.ts`, `install-skills.ts`
**Files created**: 6 new `.md` files in `src/lib/worker/skills/`

---

### Phase 2: MCP Brainstorm Signal Tools

**Goal**: Replace `[PASS]` text parsing with structured MCP signaling.

#### 2.1 New MCP tools

Add to `src/lib/mcp/tools/brainstorm-tools.ts` (new file):

```typescript
// brainstorm_signal
// Called by agents to signal turn state
{
  name: 'brainstorm_signal',
  description: 'Signal your brainstorm turn state. Use instead of text-based [PASS].',
  inputSchema: {
    type: 'object',
    properties: {
      signal: {
        type: 'string',
        enum: ['done', 'pass', 'block'],
        description: 'done = response complete, pass = agree/nothing to add, block = critical objection',
      },
      reason: {
        type: 'string',
        description: 'Brief reason (required for pass and block)',
      },
    },
    required: ['signal'],
  },
}

// brainstorm_get_state
// Called by agents to understand the current room state
{
  name: 'brainstorm_get_state',
  description: 'Get current brainstorm room state: wave number, participants, who has responded.',
  inputSchema: { type: 'object', properties: {} },
}
```

#### 2.2 API endpoint for signals

New route: `POST /api/brainstorms/signal`

The MCP server calls this with `{ sessionId, signal, reason }`. The API:

1. Finds the brainstorm participant linked to this session
2. Finds the room ID
3. Forwards to Worker HTTP: `POST :4102/brainstorms/:roomId/signal`

#### 2.3 Worker HTTP signal handler

New handler in `worker-http.ts` alongside existing brainstorm routes:

```typescript
// POST /brainstorms/:id/signal
// { participantSessionId, signal, reason }
```

The orchestrator receives the signal and:

- `done`: No change to existing behavior (already handled by `awaiting_input`)
- `pass`: Sets `participant.hasPassed = true`, `waveStatus = 'passed'` immediately, emits events. No need to wait for `awaiting_input` + text scan.
- `block`: New state — emits `participant:status { status: 'blocked' }`, injects the block reason into the wave broadcast so other participants see it.

#### 2.4 State endpoint for agents

New route: `GET /api/brainstorms/state?sessionId=...`

Returns:

```json
{
  "roomId": "...",
  "currentWave": 3,
  "status": "active",
  "participants": [
    { "name": "Claude", "role": "critic", "status": "done", "isLeader": true },
    { "name": "Gemini", "role": "optimist", "status": "thinking" }
  ],
  "myRole": "critic",
  "isLeader": true
}
```

#### 2.5 Update orchestrator signal handling

In `brainstorm-orchestrator.ts`:

- Add `handleBrainstormSignal(participantSessionId, signal, reason)` method
- Wire it into the existing `liveBrainstormHandlers` dispatch
- `pass` signal takes priority over text-based `[PASS]` detection
- `block` signal pauses the wave and injects the reason
- Keep `[PASS]` text detection as fallback (backward compat)

**Files created**: `src/lib/mcp/tools/brainstorm-tools.ts`, `src/app/api/brainstorms/signal/route.ts`
**Files changed**: `src/lib/mcp/server.ts` (register tools), `worker-http.ts`, `brainstorm-orchestrator.ts`, `event-types.ts` (new `blocked` status)

---

### Phase 3: Leader Designation

**Goal**: One participant is the designated leader with synthesis and execution authority.

#### 3.1 Schema change

Add to `brainstorm_rooms`:

```sql
leader_participant_id UUID REFERENCES brainstorm_participants(id)
```

#### 3.2 Leader selection logic

New function in `src/lib/brainstorm/leader.ts`:

```typescript
export const LEADER_PRIORITY: Record<Provider, number> = {
  anthropic: 1,
  openai: 2,
  google: 3,
  github: 4,
};

export function selectLeader(
  participants: { id: string; agentSlug: string; provider: Provider | null }[],
  explicitLeaderId?: string,
): string {
  if (explicitLeaderId) return explicitLeaderId;
  return participants.sort(
    (a, b) => (LEADER_PRIORITY[a.provider!] ?? 99) - (LEADER_PRIORITY[b.provider!] ?? 99),
  )[0].id;
}
```

#### 3.3 Preamble changes

In `buildPreamble()`:

- Leader gets: `## You Are the Leader` section explaining synthesis, tiebreaking, execution responsibility
- Non-leaders get: `## The Leader` section naming the leader and explaining deference on execution decisions
- Leader's synthesis prompt is simplified (they already have full context from participating)

#### 3.4 Synthesis optimization

Currently synthesis creates a separate one-off session. With a leader participant:

- Option A: Leader synthesizes inline (no separate session needed)
- Option B: Keep separate session but use leader's agent/model (ensure consistency)

Recommend Option A for rooms with a leader, Option B as fallback.

**Files created**: `src/lib/brainstorm/leader.ts`
**Files changed**: `schema.ts` (new column), `brainstorm-orchestrator.ts` (leader selection, preamble, synthesis), `brainstorm-service.ts`, create-dialog UI

---

### Phase 4: Preamble Rewrite (wire skills into sessions)

**Goal**: Replace the monolithic `buildPreamble()` with a skill-aware composition.

#### 4.1 Compose preamble from skills

Instead of building a giant string, the preamble references skills the agent should load:

```typescript
function buildPreamble(room, participant, leader) {
  const sections: string[] = [];

  // 1. Room context (topic, title, participants, wave config)
  sections.push(buildRoomContext(room, participant));

  // 2. Protocol reference (short — full detail is in the skill file)
  sections.push(
    'The brainstorm-protocol skill is loaded with full details on wave mechanics and MCP tools.',
  );

  // 3. Role assignment + brief
  sections.push(buildRoleSection(participant.role));
  // Full role behavior is in the skill file — just reference it here
  sections.push(
    `Your detailed role behavior is defined in the brainstorm-role-${participant.role} skill.`,
  );

  // 4. Provider tint (2-3 sentences, not a full persona)
  const tint = getProviderTint(participant.provider);
  if (tint) sections.push(`## Your Natural Tendency\n${tint}`);

  // 5. Leader designation
  sections.push(buildLeaderSection(participant, leader));

  // 6. Discussion brief (goal, constraints, audience)
  if (room.config.goal) sections.push(buildBriefSection(room.config));

  return sections.join('\n\n');
}
```

#### 4.2 Ensure skills are loaded by sessions

Skills are loaded automatically via `~/.claude/skills/` (for Claude) and `~/.agents/skills/` (for Codex). Gemini and Copilot don't natively load skills.

**For Gemini/Copilot**: The protocol and role content must be fully inlined in the preamble (not just referenced). The preamble builder detects the provider and switches between reference mode (Claude/Codex) and inline mode (Gemini/Copilot).

```typescript
if (supportsNativeSkills(participant.provider)) {
  // Short reference — skill file has the details
  sections.push(`Refer to your loaded brainstorm-role-${role} skill for behavioral guidelines.`);
} else {
  // Inline the full skill content
  sections.push(loadSkillContent(`brainstorm-role-${role}`));
}
```

**Files changed**: `brainstorm-orchestrator.ts` (`buildPreamble()` rewrite), `brainstorm-personas.ts` (simplified to tints)

---

### Phase 5: Mid-Conversation Participant Addition with Role + Model Selection

**Goal**: When adding a participant mid-brainstorm, the user chooses their role AND model.

#### 5.1 Expand hot-add API

`POST /api/brainstorms/:id/participants` already exists. Expand the request body:

```typescript
{
  agentId: string;       // existing
  role?: string;         // NEW — assigned role (critic, optimist, etc.)
  model?: string;        // NEW — model override (e.g. 'claude-sonnet-4-20250514')
}
```

#### 5.2 Update `hotAddParticipant()` in orchestrator

Currently creates a participant with no role consideration. Changes:

- Accept `role` and `model` from the control message
- If no role specified, auto-assign based on what roles are unfilled
- Build preamble with the assigned role + catch-up context from previous waves
- Pass `model` to session creation

#### 5.3 Catch-up context for late joiners

New section in preamble for mid-session additions:

```markdown
## Catch-Up Context

You are joining this brainstorm in wave 4. Here is a summary of the
discussion so far:

### Key Points Established

- [auto-generated from previous wave responses]

### Current Disagreements

- [topics where participants diverged]

### Your Fresh Perspective

As a late joiner, your outside perspective is valuable. Don't feel
bound by consensus already reached — challenge it if warranted.
```

The catch-up is generated by the orchestrator from the accumulated `waveContent` history.

#### 5.4 UI: Role + Model selector in add-participant dialog

Update `participant-sidebar.tsx`'s "Add Participant" button/dialog:

- Agent selector (existing)
- Role dropdown: critic, optimist, pragmatist, architect, wildcard, auto
- Model selector: populated from model discovery (per agent type)

**Files changed**: `brainstorm-orchestrator.ts` (`hotAddParticipant`), participant API route, `participant-sidebar.tsx`, `create-dialog.tsx`

---

### Phase 6: Standalone Skill Rewrite

**Goal**: Upgrade `~/.claude/skills/brainstorm/SKILL.md` to support the new system.

#### 6.1 Support N participants with model selection

Replace the hardcoded Gemini + Codex with a configurable participant list:

```markdown
### Step 1: Setup

Determine available models and user preferences:

- Check: `which gemini`, `which codex`
- Ask user (if not specified): How many participants? Which models? Roles?
- Default: 2 participants (Gemini + Codex), auto-assign roles

You (Claude Code) are always the LEADER — you synthesize and execute.
```

#### 6.2 Inject protocol and role context

Each CLI invocation includes the protocol rules and role-specific instructions from the skill files (inlined in the prompt since external CLIs don't load Claude skills).

#### 6.3 Leader-aware synthesis

Step 6 (Synthesize) explicitly frames Claude as the leader:

```markdown
### Step 6: Synthesize (You Are the Leader)

As the designated leader, you:

1. Identify consensus
2. Break ties using your codebase knowledge
3. Produce the actionable recommendation
4. You will be the one implementing this — keep it realistic
```

**Files changed**: `~/.claude/skills/brainstorm/SKILL.md`

---

## Phase Execution Order

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4 ──→ Phase 5
  │                                                  │
  └──────────────── Phase 6 (parallel) ──────────────┘
```

- **Phase 1** (role skills) is independent — can start immediately
- **Phase 2** (MCP signals) depends on Phase 1 only for the protocol skill content
- **Phase 3** (leader) is independent of Phase 2
- **Phase 4** (preamble rewrite) depends on Phases 1 + 3
- **Phase 5** (mid-add UX) depends on Phase 3 + 4
- **Phase 6** (standalone skill) can run in parallel with Phases 2-5

---

## Effort Estimates

| Phase                 | Complexity | Est. Effort     | Key Risk                                    |
| --------------------- | ---------- | --------------- | ------------------------------------------- |
| 1. Role skills        | Low        | 1-2 hours       | Skill content quality                       |
| 2. MCP signals        | Medium     | 3-4 hours       | MCP tool registration + orchestrator wiring |
| 3. Leader designation | Medium     | 2-3 hours       | Schema migration                            |
| 4. Preamble rewrite   | Medium     | 2-3 hours       | Gemini/Copilot inline fallback              |
| 5. Mid-add UX         | Medium     | 3-4 hours       | Catch-up context generation                 |
| 6. Standalone skill   | Low        | 1-2 hours       | Testing across CLI versions                 |
| **Total**             |            | **12-18 hours** |                                             |

---

## Migration & Backward Compatibility

1. **Old persona skills**: Kept temporarily with deprecated description. Removed after one release cycle.
2. **`[PASS]` text detection**: Remains as fallback alongside MCP `brainstorm_signal`. MCP signal takes priority.
3. **Existing rooms**: Rooms created before the migration work fine — `leaderId` is nullable, roles are already in the schema.
4. **Provider lens**: Simplified but not removed — backward-compatible change in `brainstorm-personas.ts`.

---

## Decided Questions

1. **Wildcard is a fixed role** — not a custom/user-defined role. It has predefined instructions like the other roles.
2. **Leader is fixed at room creation** — not changeable mid-brainstorm.
3. **Block = flagged objection, not a pause** — `block` signal highlights the objection in the wave broadcast but does NOT pause the wave. Discussion continues, other participants see the block reason.
4. **Gemini/Copilot skill loading — future task** — Both CLIs should support `~/.agents/skills/` in principle. If it's not wired up in Agendo's adapters yet, add it as a future task rather than building a workaround. For now, inline the content in the preamble as a stopgap.
