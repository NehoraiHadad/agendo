# Brainstorm Rooms — Design Document

## Vision

A **Brainstorm Room** is a live, free-form multi-model conversation where AI agents discuss a topic together — reacting, disagreeing, building on each other's ideas — while you watch, steer, and participate. Not batch processing. Not round-robin. A real group chat between models.

## How It Feels

```
You:      "How should we handle auth in the new API?"

Claude:   "JWT with short-lived tokens + refresh rotation.
           Here's why..."

Gemini:   "I'd push back on JWTs entirely. Session tokens
           in Redis are simpler and revocable. Claude's
           approach has the revocation problem..."

Codex:    "Gemini's right about revocation. But Redis adds
           infrastructure. What about signed cookies with
           a DB-backed session store? Best of both..."

Claude:   "Codex makes a good point. Signed cookies +
           DB sessions would work, but the DB becomes
           a bottleneck at scale. PASS."

Gemini:   "PASS — I think we've converged on the tradeoff
           space. The choice depends on scale requirements."

You:      "We're at ~1000 DAU. What's your final recommendation?"

Claude:   "At that scale, Codex's signed cookies + DB sessions
           is the clear winner. Skip JWT complexity..."
```

Messages flow in real-time. Each agent sees what others say and reacts naturally. You jump in whenever you want.

---

## Core Mechanism: Wave-Based Broadcasting

The fundamental challenge: AI agents always respond when prompted. They can't "choose" to stay silent. Without structure, 3 agents would ping-pong forever.

**Solution: Waves with PASS dampening.**

### How a Wave Works

```
Wave 1:
  1. Topic arrives (from user or previous wave)
  2. Orchestrator sends topic to ALL agents simultaneously
  3. Each agent processes independently, finishes at different times
  4. As each finishes → response appears in UI immediately (streaming)
  5. Orchestrator collects all responses for the wave

Wave 2:
  6. Once ALL agents from Wave 1 finish (or PASS):
     → Bundle all Wave 1 responses
     → Inject bundle into all agents who didn't PASS
  7. Agents react to the bundle
  8. Responses + PASSes collected

Wave N:
  9. Repeat until all agents PASS → conversation pauses
  10. User can steer (ask a question) → triggers new wave
```

### The PASS Mechanism

Each agent's system prompt includes:

> You're in a brainstorm room with other AI models. If you agree with what's been said and have nothing NEW to add — no disagreement, no new angle, no important nuance — respond with exactly: `[PASS]`
>
> Only speak when you have a substantive contribution. Echoing agreement wastes everyone's time.

**Orchestrator detects PASS:**

- Response text starts with `[PASS]` → agent is marked as "passed this wave"
- PASS responses shown as subtle "✓ Claude passed" in UI (not full message bubbles)
- Agent is excluded from next wave's injection (no point — they agreed)
- If they didn't PASS, they're included in the next wave

**Convergence:** When ALL agents PASS in a single wave → conversation pauses. User sees: "All participants have converged. Ask a follow-up or end the brainstorm."

### Why Waves (Not Pure Free-Form)

Pure event-driven (inject each response immediately into all others) would cause:

- **Message explosion**: A responds → triggers B and C → B responds → triggers A and C → exponential
- **Context fragmentation**: Agents see responses out of order, react to partial information
- **No convergence signal**: Impossible to know when to stop

Waves give the **feel** of free-form (everyone talks each wave, order doesn't matter) with **engineering sanity** (bounded, convergent, predictable cost).

### Wave Timing

```
Agent responses arrive asynchronously within a wave:

  t=0s   Topic injected into Claude, Gemini, Codex
  t=8s   Claude responds → appears in UI
  t=12s  Codex responds → appears in UI
  t=18s  Gemini responds → appears in UI
  t=18s  All done → orchestrator bundles → injects Wave 2
```

Each agent's response streams to the UI as it arrives (real-time feel). But the next wave waits until ALL agents finish (prevents partial context).

**Timeout:** If an agent hasn't responded in 120s, treat as implicit PASS for that wave. Don't block the conversation on a slow model.

---

## Architecture

### New Entity: `brainstorm_rooms`

```sql
CREATE TABLE brainstorm_rooms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects(id),
  task_id       UUID REFERENCES tasks(id),          -- optional task link
  owner_id      UUID NOT NULL REFERENCES users(id),
  title         TEXT NOT NULL,
  topic         TEXT NOT NULL,                       -- initial prompt
  status        TEXT NOT NULL DEFAULT 'active',      -- active | paused | ended
  current_wave  INTEGER NOT NULL DEFAULT 0,
  max_waves     INTEGER NOT NULL DEFAULT 10,         -- safety limit
  config        JSONB NOT NULL DEFAULT '{}',         -- future: temperature, model overrides
  synthesis     TEXT,                                 -- final summary
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE brainstorm_participants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         UUID NOT NULL REFERENCES brainstorm_rooms(id) ON DELETE CASCADE,
  agent_id        UUID NOT NULL REFERENCES agents(id),
  session_id      UUID REFERENCES sessions(id),     -- set when session spawned
  model           TEXT,                              -- optional model override
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | active | passed | left
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE brainstorm_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id         UUID NOT NULL REFERENCES brainstorm_rooms(id) ON DELETE CASCADE,
  wave            INTEGER NOT NULL,
  sender_type     TEXT NOT NULL,                     -- 'agent' | 'user'
  sender_agent_id UUID REFERENCES agents(id),
  is_pass         BOOLEAN NOT NULL DEFAULT false,
  content         TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Three Processes

```
┌─────────────────────────────────────────────────────┐
│  Next.js App                                         │
│                                                      │
│  POST /api/brainstorms           → create room       │
│  POST /api/brainstorms/:id/start → enqueue job       │
│  POST /api/brainstorms/:id/steer → user message      │
│  POST /api/brainstorms/:id/end   → end + synthesize  │
│  GET  /api/brainstorms/:id/events → SSE stream       │
│                                                      │
│  /brainstorms/:id page           → room UI           │
└──────────────────┬──────────────────────────────────┘
                   │ pg-boss: run-brainstorm
┌──────────────────▼──────────────────────────────────┐
│  Worker: Brainstorm Orchestrator                     │
│                                                      │
│  1. Creates N sessions (one per participant)          │
│  2. Subscribes to agendo_events_{sessionId} × N      │
│  3. Manages wave lifecycle                           │
│  4. Routes responses between sessions                │
│  5. Detects convergence                              │
│  6. Publishes agendo_events_{roomId} for UI          │
└──────────────────┬──────────────────────────────────┘
                   │ existing session infrastructure
┌──────────────────▼──────────────────────────────────┐
│  N Agent Sessions (existing SessionProcess)          │
│                                                      │
│  Each agent runs in its own session with:            │
│  - Brainstorm-specific system prompt                 │
│  - MCP tools available (but discussion-focused)      │
│  - Standard adapter (Claude/Codex/Gemini/Copilot)    │
└─────────────────────────────────────────────────────┘
```

### Orchestrator: `brainstorm-orchestrator.ts`

```typescript
// Core orchestration loop (pseudocode)

async function orchestrate(room: BrainstormRoom) {
  // 1. Spawn sessions for each participant
  const participants = await getParticipants(room.id);
  const sessions = await Promise.all(participants.map((p) => createBrainstormSession(p, room)));

  // 2. Subscribe to all session event channels
  const subscriptions = sessions.map((s) =>
    pgSubscribe(`agendo_events_${s.id}`, (event) => handleSessionEvent(room, s, event)),
  );

  // 3. Subscribe to room control channel (user steering)
  pgSubscribe(`brainstorm_control_${room.id}`, handleUserSteer);

  // 4. Start Wave 0: inject topic into all agents
  await startWave(room, 0, room.topic);

  // 5. Wave loop runs event-driven (not polling)
  //    handleSessionEvent fires when agents respond
  //    completeWave fires when all agents done
  //    startWave fires for next wave
  //    Until: all PASS, max waves, or user ends
}

async function startWave(room, waveNum, content) {
  // Format the injection message
  const message =
    waveNum === 0 ? formatInitialTopic(content) : formatWaveBroadcast(content, waveNum);

  // Reset participant statuses
  activeParticipants.forEach((p) => (p.waveStatus = 'thinking'));

  // Inject into all active (non-passed) participants simultaneously
  await Promise.all(activeParticipants.map((p) => injectMessage(p.sessionId, message)));

  emitRoomEvent({ type: 'wave:start', wave: waveNum });
}

function handleSessionEvent(room, session, event) {
  if (event.type === 'agent:text') {
    // Stream to room UI immediately
    emitRoomEvent({
      type: 'brainstorm:message',
      agentId: session.agentId,
      agentName: session.agentName,
      wave: room.currentWave,
      text: event.text,
      isStreaming: true,
    });
  }

  if (event.type === 'session:state' && event.status === 'awaiting_input') {
    // Agent finished their turn
    const fullResponse = collectResponseText(session);
    const isPASS = fullResponse.trim().startsWith('[PASS]');

    // Store message
    saveBrainstormMessage(room.id, room.currentWave, session.agentId, fullResponse, isPASS);

    if (isPASS) {
      markParticipantPassed(session);
      emitRoomEvent({ type: 'brainstorm:pass', agentId: session.agentId, wave: room.currentWave });
    } else {
      markParticipantDone(session);
      emitRoomEvent({
        type: 'brainstorm:message',
        agentId: session.agentId,
        wave: room.currentWave,
        text: fullResponse,
        isStreaming: false, // final
      });
    }

    // Check if wave is complete
    if (allParticipantsDoneOrPassed()) {
      completeWave(room);
    }
  }
}

function completeWave(room) {
  const waveMessages = getWaveMessages(room.currentWave);
  const allPassed = waveMessages.every((m) => m.isPASS);

  if (allPassed) {
    // CONVERGENCE — pause and wait for user
    emitRoomEvent({ type: 'brainstorm:converged', wave: room.currentWave });
    room.status = 'paused';
    return;
  }

  if (room.currentWave >= room.maxWaves) {
    // Safety limit reached
    emitRoomEvent({ type: 'brainstorm:max-waves', wave: room.currentWave });
    room.status = 'paused';
    return;
  }

  // Bundle non-PASS responses for next wave
  const bundle = waveMessages
    .filter((m) => !m.isPASS)
    .map((m) => `[${m.agentName}]: ${m.content}`)
    .join('\n\n---\n\n');

  // Next wave: only agents who didn't PASS participate
  room.currentWave++;
  startWave(room, room.currentWave, bundle);
}
```

### User Steering

The user can send messages at ANY time — even mid-wave:

```typescript
function handleUserSteer(message) {
  // Store as user message
  saveBrainstormMessage(room.id, room.currentWave, null, message.text, false);

  // Emit to UI
  emitRoomEvent({ type: 'brainstorm:user-message', text: message.text });

  if (room.status === 'paused') {
    // Resume: start new wave with user's message
    room.status = 'active';
    // Re-activate all participants (clear PASS state)
    resetAllParticipants();
    room.currentWave++;
    startWave(room, room.currentWave, message.text);
  } else {
    // Mid-wave: queue the message for injection at next wave
    // (don't interrupt agents mid-thought)
    pendingUserMessages.push(message.text);
  }
}
```

### Session Creation for Brainstorms

Each participant gets a session with a brainstorm-specific preamble:

```typescript
async function createBrainstormSession(participant, room) {
  const preamble = `
You are participating in a brainstorm room called "${room.title}".

RULES:
- You are discussing with other AI models. Their messages will be injected as
  "[ModelName]: their response".
- This is a DISCUSSION. Think critically. Disagree when you disagree.
  Build on good ideas. Challenge weak ones. Be specific and concise.
- Do NOT be a yes-man. The value is in genuine diverse perspectives.
- If you agree with everything said and have NOTHING new to add — no
  disagreement, no new angle, no important nuance — respond with exactly:
  [PASS]
- Keep responses focused. 2-4 paragraphs max unless the topic demands more.
- You have access to MCP tools if you need to look up code, tasks, or
  project context. Use them if it helps the discussion.
- Do NOT write code unless specifically asked. This is a thinking session.

TOPIC: ${room.topic}
  `.trim();

  return createSession({
    agentId: participant.agentId,
    projectId: room.projectId,
    taskId: room.taskId,
    initialPrompt: preamble,
    permissionMode: 'bypassPermissions', // for MCP access
    kind: 'conversation',
  });
}
```

---

## Frontend

### Entry Points

**From any session** (button in header):

```
[🧠 Brainstorm] → Modal:
  Title: [________________]
  Topic: [________________]
  Participants:
    ☑ Claude Code     [claude-4-opus ▾]
    ☑ Gemini CLI      [gemini-2.5-pro ▾]
    ☐ Codex CLI       [gpt-5.3-codex ▾]
    ☐ GitHub Copilot  [claude-4-sonnet ▾]
  [Start Brainstorm]
```

**From project page** (new tab or action button):

```
Project: agendo
  [Tasks] [Sessions] [Conversations] [🧠 Brainstorms]
```

**From task detail** (brainstorm about this task):

```
Task: "Redesign auth system"
  [▶ Start Session] [🧠 Brainstorm This]
```

### Room View: `/brainstorms/[id]`

```
┌──────────────────────────────────────────────────────┐
│  🧠 Auth Architecture Discussion                     │
│  Wave 3 · 3 participants · Active                    │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─ 🟣 Claude ──────────────────────── Wave 1 ──┐   │
│  │ JWT with short-lived tokens + refresh          │   │
│  │ rotation. Here's why...                        │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ 🟢 Gemini ──────────────────────── Wave 1 ──┐   │
│  │ I'd push back on JWTs entirely. Session        │   │
│  │ tokens in Redis are simpler and revocable...   │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│  ┌─ 🔵 Codex ───────────────────────── Wave 1 ──┐   │
│  │ Gemini's right about revocation. But Redis     │   │
│  │ adds infrastructure. What about signed         │   │
│  │ cookies with a DB-backed session store?         │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│  ── Wave 2 ──────────────────────────────────────    │
│                                                      │
│  ┌─ 🟣 Claude ──────────────────────── Wave 2 ──┐   │
│  │ Codex makes a good point. Signed cookies +     │   │
│  │ DB sessions would work, but the DB becomes     │   │
│  │ a bottleneck at scale.                         │   │
│  └────────────────────────────────────────────────┘   │
│                                                      │
│     ✓ Gemini passed                                  │
│     ✓ Codex passed                                   │
│                                                      │
│  🔄 Claude is thinking...                            │
│                                                      │
├──────────────────────────────────────────────────────┤
│  💬 [Type to steer the conversation...]    [Send]    │
│                                                      │
│  [Synthesize]  [End Brainstorm]                      │
└──────────────────────────────────────────────────────┘
```

**Key UI elements:**

- **Agent colors** — reuse `TEAM_COLORS` from `team-colors.ts`
- **Wave dividers** — subtle horizontal lines between waves
- **PASS indicators** — small inline "✓ Agent passed" (not full message cards)
- **Streaming** — text streams in as agent types (SSE `brainstorm:message` with `isStreaming: true`)
- **Thinking indicators** — "🔄 Gemini is thinking..." while agents process
- **Compose bar** — always visible at bottom for user steering
- **Synthesize button** — asks one agent (default: Claude) to write a summary of the full conversation

### Real-Time Events (SSE)

```typescript
// Room-level events published to agendo_events_{roomId}
type BrainstormEvent =
  | { type: 'wave:start'; wave: number }
  | {
      type: 'brainstorm:message';
      agentId: string;
      agentName: string;
      wave: number;
      text: string;
      isStreaming: boolean;
    }
  | { type: 'brainstorm:pass'; agentId: string; wave: number }
  | { type: 'brainstorm:user-message'; text: string; wave: number }
  | { type: 'brainstorm:converged'; wave: number }
  | { type: 'brainstorm:max-waves'; wave: number }
  | { type: 'brainstorm:ended'; synthesis?: string }
  | { type: 'participant:status'; agentId: string; status: 'thinking' | 'done' | 'passed' };
```

### SSE Endpoint

`GET /api/brainstorms/[id]/events` — SSE endpoint that:

1. Subscribes to `agendo_events_{roomId}` PG NOTIFY channel
2. Pushes `BrainstormEvent` objects to the client
3. On connect, replays stored `brainstorm_messages` as catch-up

---

## Synthesis

When the user clicks "Synthesize" or "End Brainstorm":

1. Collect ALL brainstorm messages across all waves
2. Format them into a single conversation transcript
3. Send to one designated agent (user's choice, default Claude) with prompt:

```
Here is the complete transcript of a brainstorm discussion between
multiple AI models:

[full transcript]

Write a synthesis that captures:
1. Key ideas that emerged
2. Points of consensus
3. Remaining disagreements or open questions
4. A recommended path forward

Be concise. Bullet points preferred.
```

4. Store synthesis in `brainstorm_rooms.synthesis`
5. Display in a collapsible panel below the conversation
6. Optionally: create an Agendo task from the synthesis (button: "Create Task from This")

---

## Adding/Removing Participants Mid-Conversation

Since the user wants the ability to "add more agents to the conversation":

**Adding:**

1. User clicks "Add Participant" → selects agent + model
2. New session created with full conversation history as context
3. Agent joins from next wave (gets the previous wave's bundle)
4. UI shows "🟡 Copilot joined the brainstorm"

**Removing:**

1. User clicks "×" on a participant
2. Session terminated gracefully (SIGTERM)
3. Agent excluded from future waves
4. UI shows "Copilot left the brainstorm"

---

## Launching from Within a Session

When launched from an existing session:

1. The existing session stays alive (it's not consumed)
2. A new brainstorm room is created
3. The current session's agent is auto-added as a participant (user can remove)
4. Room opens in a new tab/panel
5. Context from the current session is NOT auto-injected (user provides the topic manually — per your preference)

---

## Cost & Safety

**Token consumption per wave (3 agents, ~500 token responses):**

- Wave 1: 3 × (system prompt + topic) ≈ 3 × 1K = ~3K input tokens
- Wave 2: 3 × (system prompt + topic + 3 responses) ≈ 3 × 2.5K = ~7.5K
- Wave 3: 3 × (system prompt + topic + 6 responses) ≈ 3 × 4K = ~12K
- Total through 3 waves: ~30K input + ~4.5K output

**Safety rails:**

- `maxWaves` default 10, configurable per room
- 120s timeout per agent per wave (auto-PASS)
- Convergence detection (all-PASS) pauses automatically
- User can end anytime
- No code execution by default (discussion-focused preamble)

---

## Implementation Phases

### Phase 1: Core (MVP)

- [ ] DB schema: `brainstorm_rooms`, `brainstorm_participants`, `brainstorm_messages`
- [ ] API routes: create, start, steer, end
- [ ] `brainstorm-orchestrator.ts` worker job (pg-boss `run-brainstorm` queue)
- [ ] Wave management + PASS detection
- [ ] SSE endpoint for room events
- [ ] Basic room UI page with message stream + compose bar

### Phase 2: Polish

- [ ] Streaming text (forward `agent:text-delta` events through room channel)
- [ ] Participant thinking/done/passed status indicators
- [ ] Wave dividers in UI
- [ ] Synthesis feature (end → synthesize → display)
- [ ] "Create Task from This" button

### Phase 3: Flexibility

- [ ] Add/remove participants mid-brainstorm
- [ ] Launch from session header button
- [ ] Launch from task detail page
- [ ] Brainstorms tab on project page
- [ ] Model override per participant

### Phase 4: Advanced

- [ ] Conversation history replay (rejoin room, see past messages)
- [ ] Export transcript (markdown)
- [ ] Brainstorm templates (pre-built topics: "Architecture Review", "Security Audit", "API Design")
- [ ] MCP tool: `start_brainstorm` — agents can launch brainstorms themselves
