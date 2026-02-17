# Architecture Brainstorm Synthesis (v3 — Final)

> Date: 2026-02-17
> Brainstorm rounds:
>
> - **Round 1**: Gemini + Codex independent critiques → cross-pollination → Claude review → all react
> - **Expert team**: Backend Architect + Senior Frontend Dev + Code Architect (collaborative team with shared task list)
> - **Round 2 (final validation)**: Gemini critique of updated architecture → Claude counter-critique → Gemini reaction
> - Codex unavailable for Round 2 (usage limit hit)

---

## Confirmed Architecture (All Reviews Converged)

### 1. Dual Execution Mode

- **Template mode**: CLI tools (git, docker, npm) — `command_tokens` + args substitution
- **Prompt mode**: AI agents (claude, gemini, codex) — `prompt_template` + stdin pipe + `stdin.end()`
- Determined by `agent_capabilities.interaction_mode` column
- Enforced via check constraint: template requires non-null `command_tokens`

### 2. Direct Postgres + Drizzle ORM (No Supabase)

- Single Postgres container, Drizzle ORM, SSE for real-time
- Supabase local = ~8 Docker containers, 1GB+ RAM — unnecessary for personal tool

### 3. Single Package (No Monorepo)

- One `package.json`, folders: `src/app/`, `src/lib/`, `src/worker/`
- Worker imports shared code from `src/lib/` directly

### 4. Separate Worker Process (Confirmed in Final Round)

- Gemini initially proposed merging worker into Next.js
- **Rejected** because: HMR kills long-running agents during dev, web server crash = all executions die, API route timeouts unsuitable for 30-min AI tasks
- Gemini conceded: "The separation is necessary for DX, not just architecture"

### 5. SSE via fs.watch (NOT EventEmitter)

- Worker and Next.js are separate PM2 processes — cannot share in-process events
- Log streaming: `fs.watch` (inotify) + 500ms polling fallback
- Board updates: DB polling every 2s (upgrade to LISTEN/NOTIFY in later phase)

### 6. Cancellation Flow: running → cancelling → cancelled

- PID stored on `executions.pid`
- API sets `cancelling`, worker sends SIGTERM → 5s → SIGKILL
- Worker completion updates MUST guard with `WHERE status = 'running'` to handle race

### 7. Agent != Capability (1:N Relationship Confirmed)

- Gemini initially proposed merging `agent_capabilities` into `agents`
- **Rejected**: one binary (git) has many capabilities (checkout, commit, push), each with different command_tokens, args_schema, danger_level
- Gemini conceded: "Flattening would force duplicating binary path/config for every command"

### 8. task_events Audit Trail (Kept)

- Gemini initially proposed dropping it
- **Kept**: powers the task detail timeline view (created → assigned → execution started → failed → reassigned → succeeded)
- Condition: write only on meaningful state transitions, not noisy updates

### 9. worker_heartbeats (Kept with Conditions)

- Gemini still skeptical but accepted as "safety"
- Enables UI "worker last seen: X" without SSH
- Should drive automatic recovery: if heartbeat > 5min, alert or restart

### 10. Job Queue: pg-boss (wraps FOR UPDATE SKIP LOCKED)

- pg-boss replaces custom job-claimer (see research-queue-systems.md)
- Per-agent concurrency via `agents.max_concurrent` (checked before enqueue)
- Per-worker concurrency via pg-boss `teamSize`
- Cycle detection with `FOR UPDATE` row locking (correctness > performance for concurrent AI agents)

### 11. Auto-Discovery from Day 1

- No manual registration. All agents discovered automatically via PATH scan + presets
- 6-stage pipeline: SCAN → IDENTIFY → CLASSIFY → SCHEMA → ENRICH → INDEX
- "Scan & Confirm" UI flow: user confirms/dismisses discovered tools
- AI tool presets (Claude, Gemini, Codex) with hardcoded session configs
- LLM `--help` parsing and MCP client integration deferred to later phase
- See `research-auto-discovery.md` and `research-cli-tool-testing.md`

### 12. CLI-Only, No SDKs, No API Keys

- All AI tools run as CLI binaries using the user's **existing OAuth/login** (Claude Pro subscription, Google account, OpenAI account)
- `@anthropic-ai/claude-agent-sdk` rejected — requires Anthropic API key (separate billing), bypasses user's subscription
- Direct API (Anthropic Messages API, OpenAI API, Gemini API) also rejected — same reason
- Communication:
  - Claude: `stream-json` bidirectional via stdin/stdout (`--input-format stream-json --output-format stream-json`)
  - Codex: `codex app-server` JSON-RPC bidirectional (uses CLI auth)
  - Gemini: tmux + `send-keys` / `capture-pane` (no native bidirectional protocol)
  - All: tmux for interactive web terminal intervention (xterm.js + node-pty)
- Per-tool session adapters: Claude (JSON `session_id`), Gemini (`--list-sessions` parse), Codex (filesystem)
- `executions.session_ref` stores external session ID, `parentExecutionId` links continuation chain
- See `research-bidirectional-agents.md`, `research-session-management.md`, `research-claude-headless-protocol.md`

### 13. UI in Every Phase

- Each of 6 phases delivers backend + frontend + testing

### 14. Web Terminal (xterm.js + node-pty + tmux)

- Interactive web terminal lets users attach/detach from running AI agent sessions in the browser
- Stack: `@xterm/xterm` v6 (frontend) + `node-pty` (backend PTY) + `ws` (WebSocket) + tmux (process layer)
- **Separate WebSocket server** on port `:4101` (not inside Next.js) — crash isolation, independent scaling
- Runs as its own PM2 process (`terminal-ws`)
- JWT-authenticated WebSocket connections (short-lived tokens, 15 min, generated by Next.js API route)
- xterm.js requires `dynamic import` with `ssr: false` in Next.js (accesses `window`)
- See `research-web-terminal.md`

### 15. MCP Server (Agent-Initiated Tasks)

- Agent Monitor exposes an MCP server (`@modelcontextprotocol/sdk`) so AI agents can create/update tasks programmatically
- Tools: `create_task`, `update_task`, `list_tasks`, `create_subtask`, `assign_task`
- Agents launched with `--mcp-config` pointing to Agent Monitor's MCP server (stdio transport)
- **Loop prevention**: agents cannot assign tasks to themselves; max recursion depth enforced (e.g., 3 levels); rate limit on task creation per agent per minute
- `agents.mcp_enabled` flag controls which agents get the MCP config injected
- See `research-agent-task-management.md`

### 16. tmux as Process Layer

- **All AI agent executions run inside tmux sessions** — not just for web terminal, but as the universal process wrapper
- Benefits: survives worker restart (detach/reattach), provides output capture (`capture-pane`) without stdout interception, enables web terminal attach, named sessions for easy management
- tmux session naming convention: `am-{execution-id-short}` (e.g., `am-a1b2c3d4`)
- `executions.tmux_session_name` stores the session name
- Worker creates tmux session on execution start, kills session on completion/cancellation
- Gemini CLI specifically requires tmux for bidirectional communication (no native protocol)
- tmux must be installed on the host — validated at worker startup

### 17. Bidirectional Communication (Per-Agent Protocols)

- Each AI CLI agent uses a different bidirectional protocol, all via CLI (no SDK, no API keys):
  - **Claude Code**: `--input-format stream-json --output-format stream-json` — NDJSON over stdin/stdout. Known stability issue (GitHub #3187: process hanging after first turn). Fallback: tmux send-keys.
  - **Codex CLI**: `codex app-server` — JSON-RPC 2.0 over stdio. Full bidirectional with structured tool calls. Uses CLI auth (user's OpenAI login).
  - **Gemini CLI**: No native bidirectional protocol. Uses tmux `send-keys` for input and `capture-pane` for output polling. Headless mode (`-p`) is one-shot only.
- All three also run inside tmux for web terminal intervention (user can manually type into any running agent)
- `agents.session_config.bidirectionalProtocol` specifies which protocol to use
- See `research-bidirectional-agents.md`

---

## Action Items from Final Brainstorm (P0 — Before Feature Code)

These emerged from the final review and were NOT in the original architecture. They must be addressed in Phase 1.

### P0-1: Zombie Process Reconciliation on Worker Startup

- On cold start, query `WHERE status IN ('running', 'cancelling') AND worker_id = $myWorkerId`
- Check if PID exists on OS (`kill(pid, 0)`)
- Mark dead ones as `failed` with error "Worker restarted, execution orphaned"
- Add to `src/worker/index.ts` startup sequence

### P0-2: Log Retention (Phase 1, NOT Phase 6)

- Daily cron or worker startup check: delete log files older than 30 days
- `UPDATE executions SET log_file_path = NULL` for cleaned files
- Add `log_retention_days` to `worker_config` (default: 30)
- Worker should check disk space on startup; if < 5GB free, refuse new jobs

### P0-3: Cancellation Race Guard

- Worker's completion update (`succeeded`/`failed`) MUST include `WHERE status = 'running'`
- If status changed to `cancelling` during execution, the completion write should handle this:
  - If `cancelling` + process exited cleanly → set `cancelled` (not `succeeded`)
  - This prevents ambiguous final states

### P0-4: fs.watch Scope Guard

- SSE log stream route must ONLY activate fs.watch for non-terminal executions
- For completed executions: serve static file content and close immediately
- Prevents hitting inotify watcher limits on archived logs

### P0-5: "Test Capability" Button (Phase 2)

- Add lightweight capability test: runs `which <binary>` or `<binary> --version`
- Bypasses full queue system, validates agent works
- Gives immediate feedback in Phase 2 before full execution engine in Phase 4

---

## Resolved Disagreements (All Rounds)

| Topic                     | Initial Position                        | Counter                                      | Final Resolution                                                  |
| ------------------------- | --------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Worker vs single process  | Gemini: merge into Next.js              | Claude: separate for HMR/crash isolation     | **Separate** — Gemini conceded                                    |
| agent_capabilities table  | Gemini: merge into agents               | Claude: 1:N is essential                     | **Keep 1:N** — Gemini conceded                                    |
| task_events table         | Gemini: YAGNI, delete                   | Claude: powers timeline UI                   | **Keep** — Gemini conceded with condition                         |
| worker_heartbeats         | Gemini: delete, PM2 is enough           | Claude: detects frozen workers               | **Keep** — Gemini accepted as safety                              |
| Cycle detection locking   | Gemini: in-memory DFS simpler           | Claude: FOR UPDATE prevents concurrent races | **Keep DB locking** — correctness wins                            |
| exit_code column          | Gemini: missing                         | Claude: already in schema                    | **Already there** — doc 03 confirmed                              |
| Phase 2 without execution | Gemini: useless, move execution earlier | Claude: needed for Phase 3 task assignment   | **Compromise**: add "Test Capability" button                      |
| Log retention timing      | Gemini: Phase 1 P0                      | Claude: agreed                               | **Phase 1** — both agreed                                         |
| Secrets management        | Gemini: add encrypted secrets table     | Claude: defer, use .env.agents               | **Defer** — .env.agents initially, encrypted table in later phase |

---

## Risk Register

| Risk                                                  | Severity   | Mitigation                                                                                                                                                                                          |
| ----------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disk space (45GB shared)                              | **HIGH**   | Log retention cron, `max_output_bytes`, disk check on startup                                                                                                                                       |
| Zombie processes after crash                          | **HIGH**   | Worker startup sweep, heartbeat + stale reaper                                                                                                                                                      |
| WebSocket security (terminal = shell access)          | **HIGH**   | JWT auth (15 min tokens), WSS only in production, session-scoped access (can only attach to own executions), audit logging of terminal input events, max 3 concurrent interactive sessions per user |
| Cancellation race condition                           | **MEDIUM** | `WHERE status = 'running'` guard on worker completion                                                                                                                                               |
| MCP loop prevention (agent spawns agent spawns agent) | **MEDIUM** | Agents cannot self-assign; max recursion depth (3 levels); rate limit task creation per agent (10/min); `createdBy` field tracks originating agent for cycle detection                              |
| stream-json stability (GitHub #3187)                  | **MEDIUM** | Claude stream-json reported to hang after first turn. Mitigation: watchdog timer on stdin/stdout activity; fallback to tmux send-keys if stream-json unresponsive for >60s; monitor upstream fix    |
| inotify watcher limits                                | **LOW**    | Only watch non-terminal executions                                                                                                                                                                  |
| CPU saturation (3 Claude sessions)                    | **MEDIUM** | `max_concurrent` per agent, default 1 for AI agents                                                                                                                                                 |
| tmux dependency                                       | **LOW**    | Worker startup validates `tmux` binary exists and version >= 3.0; clear error message if missing; install instructions in README                                                                    |
| Secrets in process.env                                | **LOW**    | env_allowlist restricts leakage; .env.agents for sensitive keys                                                                                                                                     |

---

## Document Map (16 files: 4 planning + 12 research)

| Doc                                  | Purpose                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Planning**                         |                                                                                                     |
| 01-brainstorm-synthesis.md           | This file — decision record + risk register                                                         |
| 02-architecture.md                   | Full architecture spec (auto-discovery, session management, web terminal, MCP, bidirectional comms) |
| 03-data-model.md                     | Complete Drizzle schema (discovery + session + MCP + tmux fields)                                   |
| 04-phases.md                         | 6-phase implementation plan                                                                         |
| **Research**                         |                                                                                                     |
| research-nextjs16.md                 | Next.js 15→16 migration research                                                                    |
| research-postgres-vs-mongo.md        | DB choice validation with real-world projects                                                       |
| research-queue-systems.md            | Job queue analysis: pg-boss recommendation                                                          |
| research-cli-discovery.md            | CLI tool discovery: MCP, LLM enrichment, patterns                                                   |
| research-auto-discovery.md           | PATH scanning, Fig specs, bash-completion, classification heuristics                                |
| research-cli-tool-testing.md         | Actual CLI testing on this machine: sessions, output formats                                        |
| research-session-management.md       | Session resume patterns: Claude/Gemini/Codex adapters                                               |
| research-claude-headless-protocol.md | Claude Code stream-json protocol deep dive                                                          |
| research-bidirectional-agents.md     | Bidirectional communication: stream-json, app-server, tmux patterns                                 |
| research-web-terminal.md             | xterm.js + node-pty + tmux + WebSocket architecture                                                 |
| research-agent-task-management.md    | MCP server, agent teams, agent-initiated task management                                            |
| research-cli-ui-wrappers.md          | CLI UI wrapper libraries and patterns                                                               |
