# Agendo v2 Architecture Plan

> **Date:** 2026-03-25
> **Participants:** Claude Code (Optimist), Codex CLI (Critic), Gemini CLI (Pragmatist), GitHub Copilot CLI (Architect)
> **Discussion:** 18-wave brainstorm — "Worker Architecture: Keep or Eliminate?"
> **Status:** FINAL — approved after 24 waves of discussion
> **Execution model:** Claude Code builds. Codex + Copilot advise only.
> **Project:** New separate project (`/home/ubuntu/projects/agendo-v2/`), not a branch.
> **v1 status:** Remains running as reference until cutover. No retrofit.

---

## 1. Decision Summary

### Original Question

Should Agendo eliminate its separate worker process and merge everything into Next.js?

### Answer

**No — but the question led to something bigger.**

The brainstorm evolved through three phases:

1. **Waves 1-7:** "Keep or merge worker?" → Decision: **Keep worker for now**, targeted improvements only.
2. **Waves 8-10:** "Why does the worker exist at all?" → Insight: CLI agents require a live runtime; the question is where it lives, not whether it exists.
3. **Waves 11-18:** "How would we build this from scratch?" → Plan: v1.5 Auth0 retrofit first, then v2 clean build with durable command/event model.
4. **Waves 19-22:** User decision: **Build fresh in a new project/repo from scratch. No retrofit. Single clean build.**

### Final User Decision (Wave 22)

> "Build from 0 separately, in the cleanest way possible. New folder, new project."

This eliminates the v1.5 retrofit track entirely. The plan is now a single track:
**Clean build with Auth0, durable command/event model, and runtime contract from day 1.**

### Key Architectural Principles (Consensus)

| Principle             | Decision                                                            | Rationale                                                             |
| --------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Deployment**        | Single VPS (instance-neo)                                           | No cloud broker needed; VPS is already public with HTTPS              |
| **Auth**              | Auth0 for humans; separate credential for runtime (if daemon)       | User JWT never passed to CLI agents                                   |
| **Data durability**   | Commands written to DB before execution; events append-only         | Recovery, replay, audit trail                                         |
| **Runtime contract**  | `AgentRuntime` interface; implemented as separate daemon from day 1 | Clean separation of web lifecycle from agent lifecycle                |
| **Project structure** | New separate project (`agendo-v2/`), not branch of v1               | Zero coupling, clean slate, no retrofit                               |
| **Runtime process**   | Separate daemon from day 1 (not in-process module)                  | Greenfield = no reason to defer; avoids HMR/lifecycle issues entirely |
| **PG NOTIFY**         | Rejected permanently                                                | Tried before, failed (8KB payload limit, missed events, no ACK)       |
| **Terminal**          | Always separate process                                             | node-pty requires crash isolation                                     |
| **Execution order**   | Serial, not parallel                                                | Solo developer cannot maintain two divergent codebases                |

---

## 2. Phase 1: Foundation (New Project)

**Timeline:** Week 1
**Goal:** New repo with Auth0, DB schema, and project skeleton
**Risk:** Low (greenfield, no legacy constraints)
**Outcome:** Login works, DB ready, project structure established

> **Note:** The original v1.5 retrofit plan is preserved below for reference but is
> superseded by the clean build approach. The v1.5 scope items (Auth0, user_id,
> allowed_dirs, audit_log) are all included in the clean build — just built fresh
> instead of retrofitted.

### 2.1 Scope — What's IN

| Component                 | Change                                                                                                                                                             | Estimated Effort |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| Auth0 tenant              | Create app, configure callback URI, env vars                                                                                                                       | 1 hour           |
| Next.js middleware        | JWT verification on all API routes                                                                                                                                 | 4 hours          |
| Auth callback route       | `POST /api/auth/callback` — exchange code for token                                                                                                                | 2 hours          |
| Login/logout UI           | Login button → Auth0, logout clears session                                                                                                                        | 2 hours          |
| DB: `user_id` columns     | Add `user_id` to `sessions`, `tasks`, `executions`                                                                                                                 | 2 hours          |
| DB: `user_settings` table | `auth0_id`, `allowed_dirs`, `allowed_providers`, `settings`                                                                                                        | 1 hour           |
| API query filters         | All list queries filter by `user_id` from JWT                                                                                                                      | 4 hours          |
| Worker ACL enforcement    | `session-runner.ts` reads `allowed_dirs` from DB, validates `cwd`                                                                                                  | 2 hours          |
| Terminal WebSocket auth   | Verify JWT on WebSocket upgrade                                                                                                                                    | 2 hours          |
| Audit logging (basic)     | Simple `audit_log` table: user_id, action, resource, timestamp. Log login, session start, terminal attach. Not event-sourced — just a forward-compatible baseline. | 3 hours          |
| Testing                   | E2E: login → create session → agent runs → verify isolation                                                                                                        | 4 hours          |
| Deploy                    | Production deployment + monitoring                                                                                                                                 | 2 hours          |

**Total estimated: ~29 hours (2 weeks at ~3h/day)**

### 2.2 Scope — What's NOT IN

- No schema redesign (no `session_commands`, no `session_events`)
- No runtime contract changes
- No SSE proxy changes
- No pg-boss changes
- No worker process architecture changes
- No new event model
- No multi-tenant features beyond basic user isolation

> **Conscious debt (Codex):** v1.5 is a focused retrofit with acknowledged technical debt.
> It does NOT implement the durable command/event model (`session_commands`/`session_events`).
> This is intentional — v1.5 is a production-focused minimal change, not a final architecture.
> The current `messages` table + in-memory signaling remains as-is.
> This debt is **mandatory to resolve in v2** — `session_commands` and `session_events`
> are non-negotiable in v2, not optional improvements.
> Field names and policy names chosen in v1.5 (`user_id`, `auth0_id`, `allowed_dirs`,
> `allowed_providers`) are deliberately consistent with the v2 schema draft to avoid
> rework during migration. Basic audit logging should be included in v1.5 even if
> not event-sourced (simple action log).

### 2.2.1 Naming Consistency (v1.5 → v2)

To avoid rework, v1.5 uses the same field names that v2 will use:

| Field               | v1.5 Location                   | v2 Location                       | Same? |
| ------------------- | ------------------------------- | --------------------------------- | ----- |
| `user_id`           | sessions, tasks columns         | sessions, tasks, session_commands | Yes   |
| `auth0_id`          | user_settings.auth0_id          | users.auth0_id                    | Yes   |
| `allowed_dirs`      | user_settings.allowed_dirs      | users.allowed_dirs                | Yes   |
| `allowed_providers` | user_settings.allowed_providers | users.allowed_providers           | Yes   |

### 2.3 Auth0 Integration Details

**Token flow:**

```
Phone Browser
  → Auth0 login page (hosted by Auth0)
  → Auth0 redirects to: https://agendo.domain.com/api/auth/callback?code=XXX
  → Next.js exchanges code for JWT (id_token + access_token)
  → JWT stored in httpOnly cookie or localStorage
  → All subsequent API calls include: Authorization: Bearer <token>
  → Next.js middleware verifies JWT on every request
  → Extracts user_id (Auth0 `sub` claim) for DB queries
```

**Worker auth (v1.5):**

- Worker does NOT verify JWT directly
- Worker reads `user_id` from the `sessions` table (already set by Next.js when creating session)
- Worker reads `allowed_dirs` from `user_settings` table using the session's `user_id`
- Worker validates `cwd` against `allowed_dirs` before spawning agent
- This is ~20 lines of change in `session-runner.ts`

**Terminal auth (v1.5):**

- WebSocket upgrade request includes JWT in query param or header
- Terminal server verifies JWT before accepting connection
- Session ownership verified: terminal can only attach to user's own sessions

### 2.4 Database Changes (v1.5)

```sql
-- New table
CREATE TABLE user_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth0_id VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255),
  name VARCHAR(255),
  allowed_dirs TEXT[] NOT NULL DEFAULT '{"/home/ubuntu/projects"}',
  allowed_providers TEXT[] NOT NULL DEFAULT '{claude,codex,gemini,copilot}',
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add user_id to existing tables
ALTER TABLE sessions ADD COLUMN user_id VARCHAR(255);
ALTER TABLE tasks ADD COLUMN user_id VARCHAR(255);
ALTER TABLE executions ADD COLUMN user_id VARCHAR(255);

-- Basic audit log (forward-compatible with v2 event-sourcing)
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,  -- e.g. 'login', 'session.start', 'terminal.attach'
  resource_type VARCHAR(50),      -- e.g. 'session', 'task', 'terminal'
  resource_id UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for query performance
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
```

### 2.5 System Boundaries (v1.5)

| Boundary                  | Owner                             | Responsibility                                      |
| ------------------------- | --------------------------------- | --------------------------------------------------- |
| **Auth source of truth**  | Auth0                             | User identity, JWT issuance                         |
| **Session ownership**     | Next.js API                       | Sets `user_id` on creation, filters queries         |
| **Process spawning**      | Worker (agendo-worker)            | Only component allowed to `spawn()` CLI agents      |
| **Directory enforcement** | Worker                            | Validates `cwd` against `allowed_dirs` before spawn |
| **Terminal attachment**   | Terminal server (agendo-terminal) | Validates JWT + session ownership before pty attach |

---

## 3. Phase 2: v2 Design Artifacts

**Timeline:** Weeks 2-3 (parallel with v1.5 stabilization)
**Goal:** Lock architectural decisions for v2; produce reviewable documents
**Risk:** Zero (documents only, no code)
**Outcome:** Decision-ready artifacts for v2 go/no-go

### 3.1 Deliverables

| Artifact                          | Format                         | Content                                                         |
| --------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| ADR-001: Process Architecture     | Markdown, 1-2 pages            | 3-layer model: Control Plane + Agent Runtime + Terminal Gateway |
| ADR-002: Dual Auth Model          | Markdown, 1 page               | Auth0 for humans, M2M/internal token for runtime                |
| ADR-003: Command/Event Durability | Markdown, 2 pages + schema SQL | `session_commands` + `session_events` tables, flow diagrams     |
| ADR-004: Runtime Contract         | Markdown, 1 page + TypeScript  | `AgentRuntime` interface definition                             |
| Schema v2 Draft                   | Drizzle TypeScript (or SQL)    | All tables with types, indexes, constraints. NOT migrated.      |
| Sequence Diagrams                 | Markdown + Mermaid             | 5 flows (see below)                                             |

### 3.2 ADR Summaries

**ADR-001: Process Architecture**

```
Decision: 3-boundary architecture on single VPS

Boundaries:
1. Control Plane (Next.js, port 4100)
   - Auth0 integration, UI, API routes, task management, MCP server
   - Source of truth for: users, projects, tasks, session metadata

2. Agent Runtime (module or daemon, TBD)
   - Spawns and manages CLI agent processes
   - Enforces allowed_dirs, provider restrictions
   - Emits events, processes commands
   - Source of truth for: live session state, process lifecycle

3. Terminal Gateway (port 4101, always separate)
   - node-pty + WebSocket bridge
   - JWT-authenticated connections
   - Session ownership verification

Runtime deployment:
- Runtime is a separate daemon process from day 1 (greenfield decision, Wave 23)
- No in-process module phase; no instrumentation.ts
- AgentRuntime interface defines the contract between Next.js and daemon

Why separate terminal: node-pty is a native addon prone to segfaults.
Crash isolation prevents terminal bugs from affecting web server or agents.
```

**ADR-002: Dual Auth Model**

```
Decision: Two authentication domains

1. Human auth (Auth0):
   - Short-lived JWT (1 hour)
   - Contains: sub (user_id), email, name
   - Used for: browser → Next.js API communication
   - Refreshed via Auth0 refresh token

2. Runtime auth (internal):
   - M2M token from Auth0 Device Flow, or backend-issued long-lived token
   - Used for: runtime daemon → Next.js API communication
   - Rotated every 24 hours

3. CLI agent auth:
   - User JWT is NEVER passed to CLI agents
   - Agents use their own credentials (Claude Pro subscription, Google account, etc.)
   - Agents operate within allowed_dirs enforced by runtime
   - All agent actions logged to session_events

Why: Clear separation prevents token leakage. If runtime is compromised,
attacker gets runtime token (limited scope), not user's Auth0 token.
```

**ADR-003: Command/Event Durability**

```
Decision: All control operations are durable commands; all outputs are immutable events

session_commands table:
  id          UUID PRIMARY KEY
  session_id  UUID NOT NULL REFERENCES sessions(id)
  type        VARCHAR(50) NOT NULL
  user_id     VARCHAR(255) NOT NULL
  payload     JSONB NOT NULL DEFAULT '{}'
  status      VARCHAR(20) DEFAULT 'pending'  -- pending, executed, failed
  created_at  TIMESTAMPTZ DEFAULT NOW()

  Command types:
    START_SESSION      — { project_id, agent_id, initial_prompt, permission_mode }
    RESUME_SESSION     — { resume_prompt? }
    SEND_MESSAGE       — { content, role }
    INTERRUPT          — {}
    TERMINATE          — {}
    CHANGE_MODEL       — { model }
    CHANGE_MODE        — { permission_mode }
    TOOL_APPROVAL      — { tool_use_id, decision, updated_input? }

  Guarantee: Written to DB BEFORE runtime executes.
  On crash: unexecuted commands (status='pending') are replayed on restart.

session_events table:
  id          UUID PRIMARY KEY
  session_id  UUID NOT NULL REFERENCES sessions(id)
  seq         INTEGER NOT NULL  -- monotonic per session
  type        VARCHAR(50) NOT NULL
  payload     JSONB NOT NULL DEFAULT '{}'
  created_at  TIMESTAMPTZ DEFAULT NOW()

  Event types:
    STARTED            — { agent, model, cwd }
    AWAITING_INPUT     — {}
    TEXT_DELTA          — { content, is_thinking? }
    ASSISTANT_MESSAGE   — { content, model }
    TOOL_CALL          — { tool_name, input }
    TOOL_RESULT        — { tool_name, output }
    APPROVAL_NEEDED    — { tool_name, input, request_id }
    ERROR              — { message, code }
    COMPLETE           — { reason }
    INTERRUPTED        — {}

  Guarantee: Append-only, immutable. Never UPDATE or DELETE.
  Replay: Browser reconnect reads from session_events WHERE seq > lastEventId.

messages table (projection for chat UI):
  Derived from session_commands (SEND_MESSAGE) + session_events (ASSISTANT_MESSAGE)
  Used for rendering conversation history in the UI
  NOT the source of truth for control flow

Why:
- Recovery: on crash, scan for pending commands → replay
- Replay: browser reconnect reads event log, not in-memory state
- Audit: every action and response is permanently recorded
- Idempotency: command status prevents double-execution
```

**ADR-004: Runtime Contract**

```
Decision: AgentRuntime = TypeScript interface, implementation-agnostic

interface AgentRuntime {
  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // Session commands (write to session_commands, then execute)
  startSession(params: {
    userId: string;
    projectId: string;
    agentId: string;
    initialPrompt?: string;
    permissionMode?: PermissionMode;
  }): Promise<{ sessionId: string }>;

  resumeSession(sessionId: string, prompt?: string): Promise<void>;
  sendMessage(sessionId: string, content: string): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
  terminateSession(sessionId: string): Promise<void>;
  changeModel(sessionId: string, model: string): Promise<void>;
  changeMode(sessionId: string, mode: PermissionMode): Promise<void>;
  approveToolUse(sessionId: string, toolUseId: string, decision: ApprovalDecision): Promise<void>;

  // Queries
  getSessionStatus(sessionId: string): SessionStatus | null;
  listActiveSessions(): { sessionId: string; status: SessionStatus }[];

  // Streaming
  subscribeToEvents(sessionId: string, cb: (event: SessionEvent) => void): () => void;
}

Implementation:
- Runtime daemon exposes HTTP API on port 4102
- Next.js uses RuntimeClient (HTTP) to call the daemon
- Both sides use the AgentRuntime interface contract

Why: Contract-first design. Clean separation of web and agent lifecycles.
Runtime daemon is a separate process from day 1 (greenfield decision).
```

### 3.3 Sequence Diagrams

Five critical flows to diagram:

1. **start_session**: Phone → Auth0 → API → write START_SESSION command → runtime picks up → spawn adapter → emit STARTED event → SSE to browser
2. **send_message**: Phone → API → write SEND_MESSAGE command → runtime pipes to agent stdin → agent responds → emit TEXT_DELTA/ASSISTANT_MESSAGE events → SSE to browser
3. **interrupt**: Phone → API → write INTERRUPT command → runtime sends SIGTERM to agent → emit INTERRUPTED event → session status → idle
4. **recovery**: Process restart → scan session_commands with status='pending' → resume sessions → emit events → browser reconnects via SSE with lastEventId → catchup from session_events
5. **terminal_attach**: Phone → WebSocket upgrade with JWT → terminal server verifies JWT + session ownership → pty attach → bidirectional stream

### 3.4 Schema v2 Draft (Tables Only)

```sql
-- Core
users (id, auth0_id, email, name, allowed_dirs, allowed_providers, settings, created_at)
projects (id, user_id, name, root_path, description, settings, created_at)
agents (id, name, slug, binary_name, protocol, version, settings, created_at)

-- Sessions
sessions (id, user_id, project_id, agent_id, status, model, permission_mode, log_path, created_at, updated_at)
session_commands (id, session_id, type, user_id, payload, status, created_at)
session_events (id, session_id, seq, type, payload, created_at)

-- Tasks
tasks (id, user_id, project_id, title, description, status, priority, assignee_agent_id, parent_task_id, created_at, updated_at)

-- Audit
audit_log (id, user_id, action, resource_type, resource_id, metadata, created_at)
```

---

## 4. Phase 3: v2 Build Preconditions

### 4.1 Go/No-Go Criteria

After v1.5 runs in production for 2+ weeks, measure:

| Metric                            | Acceptable (stay v1) | Investigate | Critical (v2 needed) |
| --------------------------------- | -------------------- | ----------- | -------------------- |
| Worker crashes/week               | < 1                  | 1-2         | > 2                  |
| Restart latency (p99)             | < 5s                 | 5-10s       | > 10s                |
| SSE proxy issues/week             | 0                    | 1-2         | Recurring            |
| HMR orphan processes (dev)        | 0                    | Rare        | Regular              |
| Auth0 + ACL enforcement           | Working              | Gaps        | Broken               |
| Debug time on dual-process issues | < 1h/week            | 1-3h/week   | > 3h/week            |

**Decision rules:**

- All "Acceptable" → v2 is nice-to-have. Can stay on v1 indefinitely.
- Any "Investigate" → v2 planning becomes priority. Start implementation.
- Any "Critical" → v2 is urgent. Begin immediately.

**Codex refinement:** The threshold is "crashes that affect correctness or UX", not every
recoverable exception. A crash that auto-resumes cleanly within 5 seconds is acceptable.
What is NON-NEGOTIABLE: any command loss, any SSE event loss affecting replay, or
recurring restart/resume failures.

### 4.2 v2 Build Plan (If Approved)

| Week | Days  | Focus                                                              | Milestone                |
| ---- | ----- | ------------------------------------------------------------------ | ------------------------ |
| 4    | 1-2   | v2 branch, Drizzle schema, Auth0 (reuse v1.5 code)                 | Schema + auth ready      |
| 4    | 3-5   | Runtime contract + Claude SDK adapter + SSE direct                 | Claude runs end-to-end   |
| 5    | 6-8   | Codex adapter + ACP base + Gemini adapter                          | Multi-provider works     |
| 5    | 9-10  | `session_commands` durable + `session_events` append-only          | Durability works         |
| 6    | 11-12 | SSE reconnect from event log (lastEventId catchup)                 | Reconnect works          |
| 6    | 13-15 | Recovery: startup scan, heartbeat, idle timeout, graceful shutdown | System survives restarts |
| 7    | 16    | **Stability validation** — 48h clean run, zero command/event loss  | System validated         |
| 7    | 17-18 | Copilot adapter + remaining providers                              | All providers            |
| 7-8  | 19-20 | Task CRUD + Kanban UI + MCP server                                 | Task management          |
| 8    | 21-22 | Terminal server (separate, JWT auth)                               | Terminal from phone      |
| 8-9  | 23-25 | Tool approval UI, permission modes, PWA                            | Production-ready         |

**Total: ~25 working days (5-6 weeks)**

### 4.3 Stability Validation (Day 19)

Runtime daemon is a separate process from day 1 (greenfield decision, Wave 23).
There is no in-process vs daemon decision. This phase validates the daemon works correctly.

At day 19 (after recovery is implemented), run for 48h+ and measure:

| Question                                           | Pass                          | Fail → Fix              |
| -------------------------------------------------- | ----------------------------- | ----------------------- |
| Do commands survive runtime restart?               | Zero command loss             | Investigate immediately |
| Do events replay correctly on browser reconnect?   | Full history + live stream    | Fix event persistence   |
| Does runtime daemon restart cleanly under PM2?     | < 5s restart, sessions resume | Fix graceful shutdown   |
| Are there memory leaks from long-running sessions? | Stable over 48h               | Profile and fix         |

---

## 5. Resolved Decisions (Wave 18-19)

Locked during final alignment:

| Decision              | Resolution                                                                    | Rationale                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **v2 repo or branch** | Default: branch `v2` in same repo; revisit only if repo churn becomes harmful | Easier cherry-pick, shared git history, single .env. New repo remains option if schema/layout diverge too much |
| **Daemon threshold**  | See refined criteria below                                                    | Based on correctness/UX impact, not raw crash count                                                            |

**Refined daemon extraction triggers (Codex):**

- **Non-negotiable (immediate action):** Any command loss (commands written to DB but never executed). Any SSE event loss that breaks replay/correctness.
- **Investigation trigger:** Restart/resume failure that recurs more than once.
- **Warning signal (not alone sufficient):** HMR orphaning in dev — investigate but don't restructure if production is stable.
- **Note:** The threshold is "crashes that affect correctness or UX", not every recoverable exception. A crash that auto-resumes cleanly within 5 seconds is acceptable.
  | **v1.5 worker changes** | Yes, ~20 lines: read `allowed_dirs` from DB, validate CWD | Minimal, safe to fail, no lifecycle refactor |
  | **v2 planning deliverables** | 4 ADRs + schema draft + runtime contract + 5 diagrams | Sufficient for go/no-go decision |
  | **v1.5 → v2 naming** | Use same field names (`user_id`, `auth0_id`, `allowed_dirs`) | Avoid rework on migration |

## 6. Questions for User (Pre-Execution)

These must be answered before v1.5 implementation begins:

| #   | Question                                                                                   | Options                                                                                                                                                                                                          | Impact                                                                                                |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Q1  | **`allowed_dirs` granularity** — per-user only, per-project only, or both?                 | (a) Per-user: `user_settings.allowed_dirs` applies globally to all projects for that user. (b) Per-project: `projects.allowed_dirs` overrides per project. (c) Both: user-level default, project-level override. | Affects DB schema and ACL enforcement code in worker. Option (c) is most flexible but adds ~10 lines. |
| Q2  | **Terminal auth in v1.5** — reuse existing session JWT, or issue short-lived attach token? | (a) Reuse JWT: simpler, but token valid for full session duration. (b) Attach token: 5-min scoped token issued per attach request. More secure but more code.                                                    | Affects terminal server auth implementation. Option (a) for v1.5 speed, option (b) for v2.            |

## 7. Open Decisions

These do NOT need to be resolved before starting. They will be decided during implementation:

| Decision                | Options                                               | When to decide      |
| ----------------------- | ----------------------------------------------------- | ------------------- |
| `allowed_dirs` caching  | DB-only (simpler) vs. in-memory cache (faster)        | v1.5 implementation |
| Event storage           | PostgreSQL only vs. PostgreSQL + log files            | v2 build            |
| pg-boss in v2           | Keep (for scheduling/retry) vs. remove (direct spawn) | v2 build            |
| MCP server architecture | Bundled in Next.js vs. standalone (current)           | v2 build            |

---

## 8. Risks and Non-Goals

### 8.1 Risks

| Risk                                                   | Likelihood | Impact | Mitigation                                                |
| ------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------- |
| v1.5 Auth0 breaks existing sessions                    | Low        | High   | Test with existing sessions before deploy; rollback plan  |
| v2 build takes longer than 6 weeks                     | Medium     | Low    | v1.5 is already in production; v2 is not blocking         |
| In-process runtime doesn't work (SSE/HMR issues)       | Medium     | Medium | Runtime contract enables daemon extraction in 1 week      |
| `session_commands` adds latency (DB write before exec) | Low        | Low    | Async write + queue; measure in v2                        |
| Solo developer burnout from 9-week plan                | Medium     | High   | v1.5 delivers value in week 2; v2 is optional if v1 works |

### 8.2 Non-Goals (Explicitly Out of Scope)

- **Multi-region deployment** — single VPS is sufficient
- **Cloud broker + local daemon** — not needed when VPS hosts everything
- **Replacing CLI agents with APIs** — CLIs use user's subscription (free); APIs cost per-token
- **Multi-tenant SaaS** — basic user isolation is enough; no tenant boundaries
- **Horizontal scaling** — single VPS, single instance of each process
- **PG NOTIFY for real-time** — rejected permanently (payload limits, missed events)
- **Replacing PostgreSQL** — no SQLite, no Supabase; Drizzle + pg stays

---

## Appendix A: Brainstorm Consensus Table

Decisions that achieved full consensus (all participants agreed):

| Topic                 | Decision                                     | Waves |
| --------------------- | -------------------------------------------- | ----- |
| PG NOTIFY             | Rejected permanently                         | 3-17  |
| pg-boss               | Keep (idempotency, retry, visibility)        | 4-17  |
| Terminal server       | Always separate (node-pty)                   | 1-17  |
| Recovery logic        | Simplify, don't delete                       | 4-17  |
| ADRs before code      | Yes                                          | 12-17 |
| Runtime contract      | AgentRuntime interface                       | 13-17 |
| Durable commands      | session_commands table, write before execute | 14-17 |
| Append-only events    | session_events, immutable                    | 14-17 |
| Serial execution      | v1.5 first, v2 after (not parallel builds)   | 16-17 |
| Claude provider first | In-process SDK, simplest adapter             | 13-17 |
| Dual auth model       | Auth0 for humans, separate for runtime       | 14-17 |
| Deploy target         | Single VPS (instance-neo), not cloud broker  | 11-17 |

## Appendix B: What Each Participant Contributed

| Participant            | Role       | Key Contributions                                                                                                       |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Codex CLI**          | Critic     | `session_commands` ≠ `messages`; ADRs before code; serial not parallel execution; dual auth model; go/no-go criteria    |
| **Claude Code**        | Optimist   | Runtime contract interface; SSE streaming; phased build plan; pushed for simplification that led to greenfield decision |
| **Gemini CLI**         | Pragmatist | HMR risk identification; "transitional complexity" insight; MCP Router architecture option; pragmatic cost analysis     |
| **GitHub Copilot CLI** | Architect  | Two-track synthesis; measurement framework; detailed implementation plan; Auth0 integration specifics                   |
