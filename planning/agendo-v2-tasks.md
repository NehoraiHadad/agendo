# Agendo v2 — Task Breakdown

> **Date:** 2026-03-25
> **Executor:** Claude Code (sole implementer)
> **Advisors:** Codex CLI, Gemini CLI, GitHub Copilot CLI
> **Source:** planning/agendo-v2-architecture-plan.md
> **Approach:** New project from scratch. No retrofit. Clean build.
> **Structure:** 10 workstreams (high-level), each broken into detailed tasks.
> **Rule (Codex):** Don't detail all 57 tasks upfront. Detail each workstream when you reach it.

## Workstreams (High-Level)

| #    | Workstream                      | Days  | Depends On | Milestone                                           |
| ---- | ------------------------------- | ----- | ---------- | --------------------------------------------------- |
| WS-0 | ADRs                            | 0     | —          | Decisions locked in git                             |
| WS-1 | Foundation (repo + auth + DB)   | 1-3   | WS-0       | Login works, all tables exist                       |
| WS-2 | Runtime daemon + Claude adapter | 4-8   | WS-1       | Claude runs, SSE streams to phone                   |
| WS-3 | Command/event durability        | 9-11  | WS-2       | Write-before-execute, append-only events, reconnect |
| WS-4 | Multi-provider adapters         | 12-15 | WS-2       | Codex + Gemini + Copilot work                       |
| WS-5 | Recovery + ACL                  | 16-18 | WS-3       | Auto-resume, heartbeat, allowed_dirs enforced       |
| WS-6 | Stability validation            | 19    | WS-5       | 48h clean run, zero command/event loss              |
| WS-7 | Tasks + MCP                     | 20-22 | WS-2       | Kanban board, agents create tasks via MCP           |
| WS-8 | Terminal                        | 23    | WS-1       | Terminal from phone with JWT auth                   |
| WS-9 | Polish + PWA                    | 24-27 | WS-2       | Push notifications, mobile UI, production-ready     |

## Detailed Task Breakdown (Per Workstream)

---

## Overview

| Phase              | Duration     | Tasks        | Milestone                                   |
| ------------------ | ------------ | ------------ | ------------------------------------------- |
| 0. ADRs            | Day 0        | 4            | Decisions locked in git                     |
| 1. Foundation      | Days 1-3     | 8            | Login works, DB ready                       |
| 2. Runtime Core    | Days 4-8     | 12           | Runtime daemon + Claude adapter + SSE + API |
| 3. Durability      | Days 9-11    | 6            | Commands/events durable, reconnect works    |
| 4. Multi-Provider  | Days 12-15   | 6            | Codex + Gemini + Copilot work               |
| 5. Recovery        | Days 16-18   | 5            | Auto-resume, heartbeat, graceful shutdown   |
| 6. Stability Check | Day 19       | 2            | Validate stability, fix issues              |
| 7. Tasks + MCP     | Days 20-22   | 5            | Kanban board, MCP server                    |
| 8. Terminal        | Day 23       | 3            | Terminal from phone                         |
| 9. Polish + PWA    | Days 24-27   | 6            | Production-ready                            |
| **Total**          | **~27 days** | **57 tasks** |                                             |

---

## Phase 0: ADRs (Day 0)

Write before any code. Commit to `docs/adr/` in the new repo.

| #   | Task                                    | Deliverable                                                                                                                                                 | Est    |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 0.1 | Write ADR-001: Process Architecture     | `docs/adr/001-process-architecture.md` — 3-process model (control plane + runtime daemon + terminal), separate daemon from day 1                            | 20 min |
| 0.2 | Write ADR-002: Dual Auth Model          | `docs/adr/002-dual-auth-model.md` — Auth0 for humans, M2M for runtime if daemon, user JWT never to CLI agents                                               | 15 min |
| 0.3 | Write ADR-003: Command/Event Durability | `docs/adr/003-command-event-durability.md` — `session_commands` + `session_events` tables, write-before-execute, append-only events, messages as projection | 30 min |
| 0.4 | Write ADR-004: Runtime Contract         | `docs/adr/004-runtime-contract.md` — `AgentRuntime` TypeScript interface, implementation-agnostic                                                           | 15 min |

---

## Phase 1: Foundation (Days 1-3)

| #   | Task                           | Deliverable                                                                                                                    | Depends  | Est    |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| 1.1 | Init new repo                  | `package.json`, `tsconfig.json` (strict), `.env.example`, `.gitignore`, `pnpm-workspace.yaml` if needed                        | —        | 30 min |
| 1.2 | Next.js 16 App Router setup    | `src/app/layout.tsx`, `src/app/page.tsx`, Tailwind + shadcn/ui init, port 4100                                                 | 1.1      | 1h     |
| 1.3 | Drizzle ORM + PostgreSQL setup | `src/lib/db/index.ts` (with `globalThis` pool guard), `src/lib/db/schema.ts`                                                   | 1.1      | 1h     |
| 1.4 | DB schema — all tables         | `users`, `projects`, `agents`, `sessions`, `session_commands`, `session_events`, `tasks`, `audit_log`. Drizzle push to dev DB. | 1.3      | 2h     |
| 1.5 | Auth0 integration              | Auth0 tenant config, `src/lib/auth.ts` (token verify), `src/app/api/auth/callback/route.ts`, `src/middleware.ts` (JWT guard)   | 1.2      | 3h     |
| 1.6 | User management                | Auto-create user on first login (from Auth0 `sub`), `user_settings` with `allowed_dirs` defaults                               | 1.4, 1.5 | 1h     |
| 1.7 | Basic UI shell                 | Sidebar layout, Dashboard page, Projects list (CRUD), Agents registry (read-only)                                              | 1.5      | 3h     |
| 1.8 | PM2 ecosystem config           | `ecosystem.config.js` with agendo-v2 (port 4100), NODE_OPTIONS, env vars                                                       | 1.1      | 30 min |

**Milestone 1:** Login with Auth0 → see Dashboard → create/list projects. DB has all tables.

---

## Phase 2: Runtime Core (Days 4-8)

| #    | Task                        | Deliverable                                                                                                                                                               | Depends    | Est    |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------ |
| 2.1  | AgentRuntime interface      | `src/lib/runtime/types.ts` — TypeScript interface matching ADR-004                                                                                                        | 0.4        | 30 min |
| 2.2  | AgentRuntime singleton      | `src/lib/runtime/agent-runtime.ts` — `globalThis` singleton, `Map<sessionId, SessionProcess>`, `initialize()`, `shutdown()`                                               | 2.1        | 1h     |
| 2.3  | SessionProcess class        | `src/lib/runtime/session-process.ts` — claim, spawn, event emission, control handling, exit                                                                               | 2.2        | 4h     |
| 2.4  | Adapter interface + factory | `src/lib/runtime/adapters/types.ts`, `src/lib/runtime/adapters/adapter-factory.ts`                                                                                        | 2.1        | 30 min |
| 2.5  | Claude SDK adapter          | `src/lib/runtime/adapters/claude-sdk-adapter.ts` — uses `@anthropic-ai/claude-agent-sdk` (SDK manages process internally, no manual subprocess)                           | 2.4        | 3h     |
| 2.6  | Runtime daemon entry point  | `src/runtime/index.ts` — HTTP server (port 4102), initialize AgentRuntime, register pg-boss workers (or direct poll of `session_commands`), SIGTERM handler               | 2.2        | 2h     |
| 2.7  | Runtime HTTP API            | Runtime exposes: `POST /sessions/start`, `POST /sessions/:id/message`, `POST /sessions/:id/interrupt`, `GET /sessions/:id/events` (SSE). Auth via internal service token. | 2.6        | 2h     |
| 2.8  | Runtime client              | `src/lib/runtime-client.ts` — implements `AgentRuntime` interface by calling runtime daemon HTTP. Used by Next.js API routes.                                             | 2.7        | 1h     |
| 2.9  | API: Create session         | `POST /api/sessions` — write START_SESSION to `session_commands`, call `runtimeClient.startSession()`                                                                     | 2.8, 2.5   | 2h     |
| 2.10 | API: SSE stream             | `GET /api/sessions/[id]/events` — proxy SSE from runtime daemon `GET :4102/sessions/:id/events`                                                                           | 2.7        | 1h     |
| 2.11 | API: Send message           | `POST /api/sessions/[id]/messages` — write SEND_MESSAGE to `session_commands`, call `runtimeClient.sendMessage()`                                                         | 2.9        | 1h     |
| 2.12 | Session UI                  | `src/app/sessions/[id]/page.tsx` — SSE stream display, message input, basic chat view                                                                                     | 2.10, 2.11 | 3h     |

**Milestone 2:** Phone → login → select project → "Run Claude" → see streaming output → send follow-up message → see response. **Core loop works.**

---

## Phase 3: Durability (Days 9-11)

| #   | Task             | Deliverable                                                                                                                                                                | Depends  | Est |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- |
| 3.1 | Command writer   | All runtime commands (`startSession`, `sendMessage`, etc.) write to `session_commands` table with `status='pending'` BEFORE execution, update to `status='executed'` after | 2.7      | 2h  |
| 3.2 | Event writer     | All runtime events written to `session_events` table with monotonic `seq` per session                                                                                      | 2.3      | 2h  |
| 3.3 | Log writer       | Events also written to disk log file (for large payload fallback) at `LOG_DIR/sessions/{yyyy}/{mm}/{sessionId}.log`                                                        | 3.2      | 1h  |
| 3.4 | SSE reconnect    | `GET /api/sessions/[id]/events?lastEventId=N` — catchup from `session_events` WHERE seq > N, then switch to live stream                                                    | 3.2      | 2h  |
| 3.5 | Audit log writer | Middleware writes to `audit_log` on key actions: login, session.start, session.terminate, terminal.attach, acl.denied                                                      | 1.6      | 1h  |
| 3.6 | Test: durability | Close browser, reopen, verify full history + live stream. Kill process, restart, verify pending commands replayed.                                                         | 3.1, 3.4 | 2h  |

**Milestone 3:** Commands are durable. Events are immutable. Browser reconnect shows full history. Audit trail exists.

---

## Phase 4: Multi-Provider (Days 12-15)

| #   | Task                     | Deliverable                                                                                                | Depends       | Est |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------- | --- |
| 4.1 | Base adapter class       | `src/lib/runtime/adapters/base-adapter.ts` — shared spawn logic, process management, `spawnDetached()`     | 2.4           | 1h  |
| 4.2 | Codex app-server adapter | `src/lib/runtime/adapters/codex-adapter.ts` — JSON-RPC over NDJSON, persistent spawn, `NdjsonRpcTransport` | 4.1           | 4h  |
| 4.3 | ACP base adapter         | `src/lib/runtime/adapters/acp-base-adapter.ts` — shared ACP protocol logic for Gemini/Copilot/OpenCode     | 4.1           | 3h  |
| 4.4 | Gemini ACP adapter       | `src/lib/runtime/adapters/gemini-adapter.ts` — extends ACP base, Gemini-specific args and event mapping    | 4.3           | 2h  |
| 4.5 | Copilot ACP adapter      | `src/lib/runtime/adapters/copilot-adapter.ts` — extends ACP base, Copilot-specific args                    | 4.3           | 1h  |
| 4.6 | Provider selection UI    | Agent picker in session creation form, provider-specific settings                                          | 4.2, 4.4, 4.5 | 2h  |

**Milestone 4:** Can run Claude, Codex, Gemini, and Copilot from the phone. All stream events correctly.

---

## Phase 5: Recovery (Days 16-18)

| #   | Task              | Deliverable                                                                                                                                          | Depends  | Est |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- |
| 5.1 | Startup recovery  | On server start: scan `session_commands` with `status='pending'`, scan `sessions` with `status='active'` but no live process → resume or mark failed | 3.1      | 3h  |
| 5.2 | Heartbeat         | Every 30s: check each live session process is alive (`kill(pid, 0)` for subprocesses, SDK alive check for Claude). Mark stale sessions.              | 2.3      | 2h  |
| 5.3 | Idle timeout      | Sessions in `awaiting_input` for > configurable timeout (default 60min) → terminate gracefully                                                       | 5.2      | 1h  |
| 5.4 | Graceful shutdown | `SIGTERM` handler: iterate all live sessions → terminate each → flush logs → update DB → exit                                                        | 2.6      | 2h  |
| 5.5 | ACL enforcement   | Before every spawn: validate `cwd` against project's `allowed_dirs`. Before every tool execution: validate file paths. Deny and log to `audit_log`.  | 1.6, 3.5 | 2h  |

**Milestone 5:** System survives restarts. Stale sessions cleaned up. ACL enforced. Graceful shutdown works.

---

## Phase 6: Stability Check (Day 19)

Since runtime is a separate process from day 1 (greenfield decision), there is no
in-process vs daemon decision needed. Instead, this phase validates stability.

| #   | Task                  | Deliverable                                                                                                                | Depends | Est                  |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------- |
| 6.1 | Stability measurement | Run system for 48h+ with multiple sessions. Measure: crashes, command loss, SSE reliability, memory usage, restart latency | 5.4     | 4h (monitoring time) |
| 6.2 | Fix issues            | Address any command loss, event loss, or stability issues found                                                            | 6.1     | variable             |

**Non-negotiable thresholds (from ADR):**

- Any command loss → fix immediately
- Any SSE event loss affecting replay → fix immediately
- Recurring restart/resume failure → investigate immediately

---

## Phase 7: Tasks + MCP (Days 20-22)

| #   | Task                | Deliverable                                                                                                                                                                             | Depends  | Est |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- |
| 7.1 | Task service        | `src/lib/services/task-service.ts` — CRUD for tasks, status transitions (todo → in_progress → done), ownership                                                                          | 1.4      | 2h  |
| 7.2 | Kanban board UI     | `src/app/projects/[id]/board/page.tsx` — drag-and-drop columns, task cards, filter by assignee                                                                                          | 7.1      | 4h  |
| 7.3 | MCP server          | `src/lib/mcp/server.ts` — tools: `create_task`, `update_task`, `get_my_task`, `list_tasks`, `add_progress_note`, `get_project`, `list_projects`. Bundle with esbuild (no `@/` aliases). | 7.1      | 3h  |
| 7.4 | MCP injection       | Inject MCP server into agent sessions via adapter-specific mechanism (Claude SDK `sdkMcpServers`, Codex JSON-RPC, Gemini ACP `mcpServers`)                                              | 7.3, 4.2 | 2h  |
| 7.5 | Task ↔ Session link | Sessions can be linked to tasks. Task-linked sessions get execution preamble with `get_my_task` guidance.                                                                               | 7.1, 2.7 | 1h  |

**Milestone 7:** Agents can create and update tasks via MCP. Kanban board shows task status.

---

## Phase 8: Terminal (Day 23)

| #   | Task                    | Deliverable                                                                                                 | Depends | Est    |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------- | ------ |
| 8.1 | Terminal server         | `src/terminal/server.ts` — separate Node.js process, `ws` + `node-pty`, JWT auth on WebSocket upgrade       | 1.5     | 3h     |
| 8.2 | Terminal UI             | `src/app/sessions/[id]/terminal/page.tsx` — xterm.js v6 (`@xterm/xterm`), WebSocket connection, auto-resize | 8.1     | 2h     |
| 8.3 | PM2 config for terminal | Add `agendo-v2-terminal` to `ecosystem.config.js`, port 4101                                                | 8.1     | 15 min |

**Milestone 8:** Can open terminal from phone, see agent working in real-time.

---

## Phase 9: Polish + PWA (Days 24-27)

| #   | Task                            | Deliverable                                                                                                                                       | Depends | Est |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| 9.1 | Permission modes UI             | Tool approval cards, permission mode selector (default/acceptEdits/bypassPermissions), interactive tool renderers (AskUserQuestion, ExitPlanMode) | 2.10    | 4h  |
| 9.2 | PWA manifest + service worker   | `src/app/manifest.ts`, `public/sw.js`, push notification support                                                                                  | 1.2     | 2h  |
| 9.3 | Push notifications              | `web-push` for session status changes (awaiting_input, done), task completion                                                                     | 9.2     | 2h  |
| 9.4 | Mobile-optimized UI             | Responsive layouts, touch-friendly controls, bottom navigation, session list with status badges                                                   | 2.10    | 3h  |
| 9.5 | Error handling + loading states | Skeleton loaders, error boundaries, retry logic, offline indicator                                                                                | 1.7     | 2h  |
| 9.6 | Session management UI           | Session list, status filters, session detail with info panel (model, provider, duration, token count)                                             | 2.10    | 2h  |

**Milestone 9:** Production-ready PWA. Installable on phone. Push notifications. Responsive UI.

---

## Dependency Graph (Critical Path)

```
Phase 0 (ADRs)
  ↓
Phase 1 (Foundation: repo + auth + DB)
  ↓
Phase 2 (Runtime: contract + Claude + SSE)
  ↓
Phase 3 (Durability: commands + events + reconnect)
  ↓                          ↓
Phase 4 (Multi-Provider)     Phase 5 (Recovery)
  ↓                          ↓
  └──────── Phase 6 (Decision Point) ────────┘
                    ↓
             Phase 7 (Tasks + MCP)
                    ↓
             Phase 8 (Terminal)    ← can start from Phase 1
                    ↓
             Phase 9 (Polish + PWA) ← can start from Phase 2
```

**Critical path:** 0 → 1 → 2 → 3 → 5 → 6 = ~19 days to stability validation
**Parallel work:** Phase 4 (multi-provider) can run alongside Phase 5 (recovery)
**Parallel work:** Phase 8 (terminal) can start as early as Phase 1 (only needs auth)
**Parallel work:** Phase 9 (polish) can start incrementally from Phase 2

---

## Execution Rules

1. **Claude Code executes all tasks.** Codex and Copilot advise only.
2. **Each phase ends with a working milestone** — no partial phases.
3. **ADRs are committed before any implementation code.**
4. **`session_commands` write-before-execute** enforced from Phase 3 onward.
5. **No code from Agendo v1 is copied** — all logic rewritten clean. Concepts and learnings from v1 inform the design, but no file copying.
6. **TDD workflow** — tests first for runtime core (Phase 2-3). UI can be test-later.
7. **`allowed_dirs` is per-project** (each project has its own `root_path` which is the allowed directory).
8. **Terminal auth uses session JWT** in initial build. Short-lived attach tokens deferred to hardening phase.
9. **Separate project** — new folder (`/home/ubuntu/projects/agendo-v2`), new repo. v1 stays running as reference until cutover.
10. **Runtime is a separate process from day 1** (Codex's recommendation for greenfield). Next.js = control plane, Runtime daemon = agent management. Communication via localhost HTTP (runtime contract interface over HTTP).

## Architecture (Greenfield, Updated per Wave 23)

```
/home/ubuntu/projects/agendo-v2/
├── src/
│   ├── app/                    ← Next.js control plane (port 4100)
│   │   ├── api/                ← Auth0, sessions, tasks, SSE proxy to runtime
│   │   └── (pages)             ← UI
│   ├── lib/
│   │   ├── auth.ts             ← Auth0 JWT verification
│   │   ├── db/                 ← Drizzle + PostgreSQL
│   │   ├── services/           ← Business logic
│   │   └── runtime-client.ts   ← HTTP client for runtime daemon (implements AgentRuntime)
│   ├── runtime/                ← Runtime daemon (separate process, port 4102)
│   │   ├── index.ts            ← Entry point, HTTP server, pg-boss worker
│   │   ├── agent-runtime.ts    ← AgentRuntime implementation (daemon-side)
│   │   ├── session-process.ts  ← Session lifecycle management
│   │   └── adapters/           ← Claude SDK, Codex, Gemini, Copilot
│   └── terminal/               ← Terminal server (separate process, port 4101)
│       └── server.ts           ← node-pty + WebSocket
├── docs/
│   └── adr/                    ← Architecture Decision Records
├── ecosystem.config.js         ← PM2: agendo-v2 + agendo-v2-runtime + agendo-v2-terminal
└── package.json
```

Three PM2 processes:

- `agendo-v2` (port 4100): Next.js control plane — Auth0, UI, API
- `agendo-v2-runtime` (port 4102): Agent runtime daemon — spawns CLIs, manages sessions
- `agendo-v2-terminal` (port 4101): Terminal gateway — node-pty + WebSocket

---

## What's NOT Built (Non-Goals)

- Brainstorm orchestrator (v1 feature, not in v2 initial)
- Execution mode (template-mode capabilities — sessions only)
- GitHub sync
- tmux integration (direct pty, no tmux layer)
- Multi-region / multi-VPS
- Billing / usage tracking
- Plugin system
