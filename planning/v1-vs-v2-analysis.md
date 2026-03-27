# Agendo v1 vs v2: Architecture Comparison & Recommendation

**Date:** 2026-03-26
**Analyst:** Claude Code (automated deep research)

---

## Executive Summary

**v1** is a mature, feature-rich product (~124K LOC, 689 files, 594 commits, 2 releases) with deep agent integrations, multi-agent orchestration, and a comprehensive UI. **v2** is a clean architectural rebuild (~27K LOC, 167 files, 33 commits, 0 releases) that re-implements v1's core features on a stronger foundation (Auth0, durable event log, separated runtime daemon) but is missing ~40% of v1's advanced features.

**Recommendation: Option B — Backport v2's architectural improvements into v1.**

The cost of completing v2 to feature parity is prohibitive (estimated 3-6 months), while v1's codebase is already high quality and the specific architectural gains of v2 can be incrementally adopted.

---

## 1. Scale Comparison

| Metric           | v1                                           | v2                                 |
| ---------------- | -------------------------------------------- | ---------------------------------- |
| TypeScript files | 689                                          | 167                                |
| Lines of code    | ~124,000                                     | ~27,000                            |
| Git commits      | 594                                          | 33                                 |
| Tagged releases  | 2 (v0.1.0, v0.2.0)                           | 0                                  |
| Package version  | 0.2.0                                        | 0.1.0                              |
| DB tables        | 17                                           | 15                                 |
| DB enums         | 12                                           | ~6                                 |
| API routes       | 116                                          | 42                                 |
| Services         | 40                                           | 13                                 |
| Test files       | 115                                          | 10                                 |
| React components | 174                                          | ~40                                |
| Hooks            | 23                                           | ~8                                 |
| Agent adapters   | 5 (Claude, Codex, Gemini, Copilot, OpenCode) | 4 (Claude, Codex, Gemini, Copilot) |
| MCP tools        | 50+ (9 tool groups)                          | 14                                 |

v1 is roughly **4.6x larger** than v2 by lines of code.

---

## 2. Architecture Comparison

### What v1 Does

```
Next.js (4100) ──pg-boss──> Worker (4102) ──adapters──> AI CLIs
                                                └──> MCP server (stdio)
Terminal (4101) ──node-pty+tmux──> shells
```

- 4 PM2-managed processes (Next.js, Worker, Terminal, PostgreSQL)
- pg-boss (PostgreSQL-backed) job queue for session dispatch
- Worker is a queue consumer that claims and runs jobs
- SSE via in-memory event listeners + log file catchup on reconnect
- No authentication (single-user, JWT only for internal comms)

### What v2 Does

```
Next.js (4100) ──HTTP/JWT──> Runtime Daemon (4102) ──adapters──> AI CLIs
                                                        └──> MCP server (stdio)
Terminal (4101) ──node-pty──> shells
```

- 3 processes (Next.js "control plane", Runtime "data plane", Terminal gateway)
- No pg-boss — runtime daemon manages its own process tree via `AgentRuntime` interface
- Durable command/event backbone: `session_commands` (write-before-execute) + `session_events` (append-only)
- Auth0 OAuth for human users, M2M token for service-to-service
- SSE from DB event replay (`WHERE seq > lastEventId`)

### Key Architectural Differences

| Aspect                    | v1                                          | v2                                   | Winner       |
| ------------------------- | ------------------------------------------- | ------------------------------------ | ------------ |
| **Auth**                  | None (single-user)                          | Auth0 OAuth + per-user ACL           | v2           |
| **Command durability**    | In-memory only                              | Write-before-execute to DB           | v2           |
| **Event persistence**     | NDJSON log files + in-memory                | Append-only DB table with sequence   | v2           |
| **Process separation**    | Worker entangled via pg-boss                | Clean HTTP API contract (ADR-004)    | v2           |
| **Job queue**             | pg-boss v10 (complex, slot management bugs) | No queue — direct runtime management | v2           |
| **Inter-process comms**   | pg-boss + in-memory listeners               | Localhost HTTP + DB polling          | v2           |
| **Reconnect reliability** | Log file catchup (fragile)                  | DB seq-based replay (durable)        | v2           |
| **Agent SDK**             | Claude SDK + ACP for others                 | Same approach                        | Tie          |
| **Terminal**              | node-pty + tmux                             | node-pty (no tmux)                   | v2 (simpler) |
| **Audit trail**           | Task events only                            | Full `audit_log` table               | v2           |

### Honest Assessment

v2's architecture is genuinely cleaner in the areas it addresses. The write-before-execute pattern, append-only event log, and clean runtime separation solve real bugs that v1 has encountered (documented: HMR orphans, command loss on crash, SSE reconnect failures, pg-boss slot drain). These aren't theoretical — they're problems that required significant workaround code in v1 (zombie reconciler, stale reaper, slot release futures, terminate/cancel kill flags).

However, v1 has also addressed most of these problems through patches. The zombie reconciler, auto-resume, heartbeat monitoring, and NDJSON log catchup together provide reasonable (if less elegant) reliability.

---

## 3. Feature Completeness Matrix

### Core Features (both have)

| Feature                            | v1                            | v2                |
| ---------------------------------- | ----------------------------- | ----------------- |
| Session management (multi-turn AI) | Full                          | Full              |
| Claude adapter (SDK)               | Full                          | Full              |
| Codex adapter (app-server)         | Full                          | Full              |
| Gemini adapter (ACP)               | Full                          | Full              |
| Copilot adapter (ACP)              | Full                          | Full              |
| MCP server (stdio)                 | 50+ tools                     | 14 tools          |
| SSE real-time streaming            | Full                          | Full              |
| Terminal integration               | Full (tmux + xterm.js)        | Full (xterm.js)   |
| Kanban task board                  | Full                          | Full              |
| Task dependencies                  | Full (with cycle detection)   | Schema only       |
| Plans with versioning              | Full + execution + validation | Basic CRUD + diff |
| Push notifications (PWA)           | Full                          | Full              |
| Session auto-resume                | Full                          | Full              |
| Permission modes                   | 5 modes                       | 5 modes           |
| Tool approval UI                   | Full                          | Full              |
| Brainstorm rooms                   | Full (3,400 LOC orchestrator) | Implemented       |

### Features ONLY in v1

| Feature                       | Complexity | Notes                                                          |
| ----------------------------- | ---------- | -------------------------------------------------------------- |
| **OpenCode adapter**          | Medium     | 5th agent adapter                                              |
| **Session fork**              | High       | Branch conversation at any point                               |
| **Session fork-to-agent**     | High       | Switch AI with context transfer + summarization                |
| **Agent discovery**           | High       | PATH scan, help parsing, man pages, completion, MCP discovery  |
| **Agent auth flows**          | Medium     | OAuth/API key setup per agent                                  |
| **GitHub integration**        | High       | OAuth, repo connection, issue→task sync, polling               |
| **Context snapshots**         | Medium     | Save/resume investigation state                                |
| **Artifacts**                 | Medium     | HTML/SVG rendering from MCP                                    |
| **Workspaces**                | High       | Multi-agent grid layout with react-grid-layout                 |
| **Team canvas**               | High       | xyFlow-based team builder + monitor                            |
| **Team MCP tools**            | Medium     | create_team, send_team_message, get_team_status, get_teammates |
| **Command palette**           | Low        | cmdk integration                                               |
| **Config editor**             | Medium     | In-browser agent config editing                                |
| **Session import**            | Medium     | Import from Claude/Gemini/Codex native sessions                |
| **Global search**             | Low        | Sessions, tasks search                                         |
| **Dashboard**                 | Low        | Stats, overview                                                |
| **Version/upgrade manager**   | Medium     | Streaming upgrade with rollback                                |
| **Onboarding wizard**         | Low        | First-run setup                                                |
| **Support chat**              | Low        | Built-in support session                                       |
| **File contention detection** | Medium     | Cross-session file conflict alerts                             |
| **Git context capture**       | Medium     | Branch/commit/staged tracking per session                      |
| **MCP server management**     | Medium     | Global registry, per-project enablement                        |
| **Skill registry**            | Medium     | SKILL.md deployment to agents                                  |
| **Token usage tracking**      | Medium     | Per-provider breakdown                                         |
| **Model discovery**           | Medium     | Per-agent model listing                                        |
| **Log rotation**              | Low        | Automated log cleanup                                          |
| **Summarization providers**   | Medium     | For agent-switch context transfer                              |
| **Brainstorm telemetry**      | Low        | Quality analytics                                              |
| **Worker config (runtime)**   | Low        | DB-backed tunable settings                                     |

That's **25+ features** ranging from low to high complexity that exist in v1 but not in v2.

### Features ONLY in v2

| Feature                   | Complexity | Notes                                                  |
| ------------------------- | ---------- | ------------------------------------------------------ |
| **Auth0 authentication**  | Medium     | Login/logout, JWKS, user provisioning                  |
| **Users table**           | Low        | Per-user ACL (allowed_dirs, allowed_providers)         |
| **Write-before-execute**  | Medium     | `session_commands` durability pattern                  |
| **Append-only event log** | Medium     | `session_events` with seq-based replay                 |
| **Audit log**             | Low        | Full action audit trail                                |
| **ACL service**           | Medium     | Path traversal protection, per-user resource ownership |
| **Runtime API contract**  | Medium     | `AgentRuntime` interface + `RuntimeClient`             |

That's **7 features**, all architectural/infrastructure rather than user-facing.

---

## 4. Code Quality Comparison

| Aspect                | v1                                     | v2                            |
| --------------------- | -------------------------------------- | ----------------------------- |
| TypeScript strictness | Strict, zero `any`                     | Strict, zero `any`            |
| Test files            | 115                                    | 10                            |
| Error handling        | AppError hierarchy + withErrorBoundary | Same pattern                  |
| Service layer         | 40 services, clean separation          | 13 services, clean separation |
| API patterns          | withErrorBoundary, assertUUID          | Same patterns                 |
| Adapter abstraction   | BaseAgentAdapter → AbstractAcpAdapter  | Similar factory               |
| Code comments         | Moderate                               | Systematic (phase headers)    |
| Zod validation        | v3                                     | v4 (newer)                    |
| Package versions      | Slightly older                         | Slightly newer                |

**Verdict:** Both codebases are high quality. v2 is cleaner by virtue of being smaller and newer, but v1's quality is not significantly worse — it just has more code to maintain. v1 has 11.5x more tests.

---

## 5. Cost Analysis

### Option A: Complete v2 to Feature Parity

**Estimated effort:** 3-6 months of intensive development

What needs to be built:

- 25+ missing features (see Section 3)
- ~36 missing MCP tools
- ~74 missing API routes
- ~27 missing services
- ~134 missing components
- ~13 missing hooks
- ~105 missing test files
- Session fork/fork-to-agent system
- Agent discovery pipeline
- GitHub integration
- Workspace multi-agent grid
- Team canvas builder
- Config editor
- Version/upgrade management
- And much more

**Risk:** High. v2 may never reach parity because v1 keeps evolving. You're chasing a moving target.

**Benefit:** Cleaner architecture for the long term.

### Option B: Backport v2 Improvements into v1

**Estimated effort:** 2-4 weeks per improvement

Key items to backport:

1. **Auth0 + Users table** (~1-2 weeks): Add `users` table, Auth0 OAuth routes, `userId` FK to sessions/tasks/projects, middleware. This is the biggest change.
2. **Durable event log** (~1 week): Add `session_events` table alongside existing NDJSON logs. Dual-write initially, then migrate SSE to DB-backed replay.
3. **Write-before-execute** (~3-5 days): Add `session_commands` table, wrap control dispatch in `executeWithDurability`.
4. **Audit log** (~2-3 days): Add `audit_log` table, instrument key service methods.
5. **ACL service** (~3-5 days): Add ownership checks to existing `withErrorBoundary`.
6. **Drop pg-boss** (~1-2 weeks): Replace with direct runtime management (biggest risk item — pg-boss is deeply embedded).

**Total estimate:** 4-8 weeks for the architectural improvements that matter.

**Risk:** Moderate. Each change can be done incrementally. Auth0 is the riskiest because it touches every route.

**Benefit:** Keep all 25+ features, 115 tests, 594 commits of institutional knowledge.

### Option C: Abandon v2, Improve v1 Only

**Estimated effort:** Ongoing

**Risk:** Low. v1 is already working well.

**Benefit:** No context switching. But you miss the genuine architectural improvements.

### Option D: Merge (take best of each)

This is essentially Option B with extra steps. Since v2 was built as a clean rewrite (no shared code), "merging" means backporting v2's patterns into v1.

---

## 6. The Critical Question: Is pg-boss the Problem?

Much of v2's architectural motivation centers on removing pg-boss entanglement. Let's examine whether this is still a real problem:

**pg-boss issues encountered in v1 (from MEMORY.md and bug fixes):**

- v10 removed `teamSize` → required multiple `boss.work()` calls
- Stale `active` jobs from crashed workers block new sessions
- Slot drain: sessions in `awaiting_input` held slots forever
- Required `slotReleaseFuture` workaround
- `StaleReaper` service to clean up abandoned jobs

**v1's current mitigations:**

- Slot release future (resolves on first `awaiting_input`)
- Live session procs map (worker manages processes directly after slot release)
- Zombie reconciler (kills orphaned processes, re-enqueues)
- Stale reaper (cleans abandoned pg-boss jobs)
- Heartbeat monitoring

**Assessment:** v1 has accumulated ~500-800 lines of workaround code for pg-boss issues. Removing pg-boss would simplify the codebase significantly — but it's a contained area of complexity, not a systemic problem.

---

## 7. Recommendation

### **Option B: Backport v2's Architecture into v1**

**Reasoning:**

1. **v1 is 4.6x larger and has 25+ features v2 lacks.** Rebuilding these in v2 is 3-6 months of work with high risk of never reaching parity.

2. **v2's genuine improvements are architectural, not functional.** Auth0, durable events, write-before-execute, and audit logging are infrastructure changes that can be incrementally added to v1 without rewriting business logic.

3. **v1's code quality is already high.** Zero `any` types, 115 test files, clean service layer, strong error handling. The codebase is not "legacy" — it's actively maintained and well-structured.

4. **v2 validated the architecture but served its purpose.** The 33-commit exploration proved which patterns work. Now apply those patterns to the production codebase.

5. **The pg-boss removal can wait.** The workarounds work. If you do remove it later, v1's `liveSessionProcs` pattern already moves toward direct runtime management.

### Recommended Backport Sequence

| Priority | Item                                       | Effort    | Impact                                  |
| -------- | ------------------------------------------ | --------- | --------------------------------------- |
| 1        | Durable event log (`session_events` table) | 1 week    | Eliminates reconnect reliability issues |
| 2        | Write-before-execute (`session_commands`)  | 3-5 days  | Eliminates command loss on crash        |
| 3        | Audit log                                  | 2-3 days  | Compliance, debugging                   |
| 4        | Auth0 + Users (if multi-user needed)       | 1-2 weeks | Only if you need multi-user             |
| 5        | ACL service                                | 3-5 days  | Only if you add users                   |
| 6        | Drop pg-boss                               | 1-2 weeks | Simplification, but not urgent          |

### What to Do with v2

- **Keep it as a reference** — the ADRs and clean patterns are valuable documentation
- **Don't delete it** — it validates architectural decisions
- **Stop active development** — redirect all effort to v1
- **Extract learnings** — the `session_commands`/`session_events` pattern, `RuntimeClient` contract, and Auth0 flow are directly portable

---

## Appendix A: Dependency Modernization Opportunities

v2 uses newer versions of several key packages. These can be upgraded in v1 independently:

| Package      | v1     | v2      | Action                     |
| ------------ | ------ | ------- | -------------------------- |
| zod          | ^3     | ^4.3.6  | Upgrade (breaking changes) |
| drizzle-orm  | ^0.44  | ^0.45.1 | Upgrade (minor)            |
| next         | 16.1.6 | 16.2.1  | Upgrade (minor)            |
| vitest       | ^3     | ^4.1.1  | Upgrade (major)            |
| lucide-react | ^0.474 | ^1.7.0  | Upgrade (major)            |
| shadcn       | ^3.8.5 | ^4.1.0  | Upgrade (major)            |

## Appendix B: v2 ADR Summary

- **ADR-001: Lifecycle Boundaries** — Separate control plane (Next.js) from data plane (runtime daemon)
- **ADR-002: Auth0 Integration** — OAuth for humans, M2M for services, no user JWT to agents
- **ADR-003: Durable Command/Event Backbone** — Write-before-execute + append-only events
- **ADR-004: Runtime Contract** — TypeScript `AgentRuntime` interface as the only API

All four ADRs are portable to v1 as incremental improvements.
