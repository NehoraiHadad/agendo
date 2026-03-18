# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

agendo is a Next.js 16 application for managing AI coding agents (Claude, Codex, Gemini, Copilot). It provides agent discovery, task management (Kanban), execution orchestration with bidirectional communication, live log streaming, and an MCP server for agent-initiated tasks.

## Source of Truth

- `planning/03-data-model.md` — THE authority for all table names, column names, enum values, and TypeScript types. When in doubt, check this file.
- `planning/02-architecture.md` — system architecture and confirmed technical decisions
- `planning/01-brainstorm-synthesis.md` — confirmed design decisions
- `plan/phase-*.md` — detailed implementation plans per phase

## Commands

```bash
# Development (never run pnpm dev directly — use PM2)
./scripts/safe-restart-worker.sh  # ✅ ALWAYS use this to restart the worker (safe from inside sessions)
./scripts/safe-restart-agendo.sh  # restart Next.js app SAFELY (waits for sessions to end)
pm2 restart agendo              # ⚠ DANGER during active sessions — kills MCP connection

# Build
pnpm build:all                  # build everything (app + worker + MCP)
pnpm build                      # Next.js production build
pnpm worker:build               # build worker with esbuild (NOT tsc — OOMs)
pnpm build:mcp                  # build MCP server bundle

# Quality checks
pnpm lint                       # ESLint (zero warnings policy)
pnpm typecheck                  # tsc --noEmit
pnpm format:check               # Prettier check

# Tests
pnpm test                       # run all tests (vitest)
pnpm test:watch                 # watch mode
pnpm vitest run src/lib/services/__tests__/task-service.test.ts  # single test file

# Database
pnpm db:setup                   # create schema from scratch (drizzle-kit push)
pnpm db:generate                # generate migration from schema changes (for upgrades)
pnpm db:migrate                 # apply migrations (for upgrades)
pnpm db:studio                  # open Drizzle Studio (web UI)
pnpm db:seed                    # seed database (runs seed.ts + seed-repo-integration-capabilities.ts)

# Worker dev (hot-reload, no build needed)
pnpm worker:dev                 # tsx watch for local dev

# Release & upgrade management
./scripts/release.sh patch|minor|major  # bump version, tag, changelog
./scripts/release.sh minor --push       # bump + push to remote
./scripts/upgrade.sh                    # safe upgrade to latest version
./scripts/upgrade.sh --to v0.3.0        # upgrade to specific version
./scripts/rollback.sh                   # rollback to pre-upgrade state
```

## Tech Stack

- **Framework**: Next.js 16 (App Router, React 19, TypeScript strict)
- **Database**: PostgreSQL + Drizzle ORM (no Supabase, no raw SQL)
- **Queue**: pg-boss v10
- **Process manager**: PM2
- **UI**: shadcn/ui + Tailwind CSS
- **State**: Zustand (client), Server Components (server)
- **Real-time**: SSE (board updates, log streaming), Worker HTTP (port 4102, events path), WebSocket (terminal)
- **Terminal**: xterm.js v6 (`@xterm/*` scoped packages) + node-pty + `ws` WebSocket
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)

## PM2 Services

| Service         | Port | PM2 Name          |
| --------------- | ---- | ----------------- |
| Next.js app     | 4100 | `agendo`          |
| Worker          | 4102 | `agendo-worker`   |
| Terminal server | 4101 | `agendo-terminal` |

Config: `/home/ubuntu/projects/agendo/ecosystem.config.js`. After env changes: `pm2 restart <name> --update-env && pm2 save`. To fully purge old vars: `pm2 delete <name> && pm2 start ecosystem.config.js --only <name>`.

Worker reads env from `ecosystem.config.js` (NOT `.env.local`). The Next.js app reads `.env.local`.

### Safe Restart Patterns

`agendo-worker` **never** hosts the MCP server, but **does host agent sessions**.

⚠️ **NEVER run `pm2 restart agendo-worker` directly from an agent session** — it kills your own process and triggers an infinite restart loop. Always use the safe script:

```bash
# From inside an agent session (auto-disables resume before restarting):
./scripts/safe-restart-worker.sh              # build + restart
./scripts/safe-restart-worker.sh --no-build   # restart only

# From a regular terminal (no agent session), direct restart is safe:
pm2 restart agendo-worker --update-env
```

`agendo` (Next.js) **hosts the MCP server**. Restarting it drops any live agent MCP connection:

```bash
# SAFE: waits for active sessions to end first (up to 5 min), then restarts
./scripts/safe-restart-agendo.sh

# IMMEDIATE: skips the wait (use only when no sessions are active)
./scripts/safe-restart-agendo.sh --force
```

`pm2 restart agendo` directly is safe only when you are certain no agent sessions are active.

## Required Environment Variables

From `src/lib/config.ts` (validated with Zod on startup):

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — min 16 chars, used for API auth and Worker HTTP Bearer auth
- `LOG_DIR` — defaults to `./logs` (production uses `/data/agendo/logs` via ecosystem.config.js)
- `ALLOWED_WORKING_DIRS` — colon-separated allowed dirs (default `/home/ubuntu/projects:/tmp`)
- `MCP_SERVER_PATH` — path to bundled MCP server (`dist/mcp-server.js`)
- `WORKER_HTTP_PORT` — Worker HTTP server port (default 4102)

## Architecture: Three Processes

The system runs as three cooperating processes:

```
┌─────────────────────────────────────────┐
│  Next.js App (port 4100)                │
│  - API routes (src/app/api/)            │
│  - Kanban UI, session viewer            │
│  - Streaming proxy: /api/sessions/:id/  │
│    events → Worker SSE (port 4102)      │
└───────────────┬─────────────────────────┘
                │ pg-boss queues + Worker HTTP (port 4102)
┌───────────────▼─────────────────────────┐
│  Worker (agendo-worker, port 4102)      │
│  - Dequeues execute-capability jobs     │
│  - Dequeues run-session jobs            │
│  - Spawns AI CLI subprocesses           │
│  - Serves SSE directly (in-memory      │
│    listeners, Worker HTTP endpoints)    │
└───────────────┬─────────────────────────┘
                │ stdio transport
┌───────────────▼─────────────────────────┐
│  MCP Server (dist/mcp-server.js)        │
│  - Injected into agent sessions         │
│  - Exposes task management tools        │
│  - Calls agendo API over HTTP           │
└─────────────────────────────────────────┘
```

## Sessions

Sessions are long-lived AI conversations (`run-session` queue, `session-runner.ts`). The worker spawns the agent CLI process (`session-process.ts`) and keeps it alive for multi-turn interaction. Frontend sends messages via HTTP POST to Worker (port 4102); worker streams `AgendoEvent`s via in-memory SSE listeners. The Next.js route handler at `/api/sessions/:id/events` acts as a streaming proxy to Worker HTTP (`GET :4102/sessions/:id/events`). Use POST `/api/sessions`.

### Session `kind` Field

- `kind='conversation'` — all normal agent sessions (free chat and task sessions). Always persistent. This is the default.
- `kind='execution'` — reserved for ephemeral background runs (e.g. config analysis). Sets `--no-session-persistence` for Claude.

Preamble routing uses `session.taskId` (not `kind`): if `taskId` is present, the execution preamble is injected; otherwise the planning preamble is used.

### Session Permission Modes

- `bypassPermissions` — auto-approves everything, including Bash and MCP tool calls. Use for autonomous agents that need to run shell commands or call MCP tools without prompts.
- `acceptEdits` — auto-approves file Edit/Write/Read tools only. Blocks Bash and MCP tool calls (agents will pause waiting for approval). Do **not** use for agents that need MCP updates or build steps.
- `default` — interactive; prompts the user for each approval.

## Real-Time Flow

```
Worker (session-process.ts)
  → emitEvent() notifies sessionEventListeners (in-memory Map)
  → Worker SSE handler (src/lib/worker/worker-sse.ts) pushes to connected browsers
  → Next.js streaming proxy (GET /api/sessions/:id/events → Worker :4102/sessions/:id/events)
  → React hooks (use-session-stream.ts) update Zustand store
```

Control signals flow in reverse:

```
Frontend sends message
  → POST /api/sessions/[id]/messages
  → sendSessionControl() → POST localhost:4102/sessions/:id/control (Worker HTTP)
  → Worker reads in session-process.ts via onControl()
  → Pipes stdin to agent CLI
```

SSE reconnect catchup reads from the session log file (no DB needed for replay).

## Worker Adapter Pattern

Each AI CLI gets an adapter in `src/lib/worker/adapters/`:

- `claude-sdk-adapter.ts` — Claude Code (via `@anthropic-ai/claude-agent-sdk`, persistent session)
- `codex-app-server-adapter.ts` — OpenAI Codex CLI (JSON-RPC via `codex app-server`)
- `gemini-adapter.ts` — Gemini CLI (ACP protocol via `@agentclientprotocol/sdk`)
- `copilot-adapter.ts` — GitHub Copilot CLI (ACP protocol, shares `AcpTransport` with Gemini)

Shared ACP infrastructure:

- `gemini-acp-transport.ts` — `AcpTransport` class (generic, used by both Gemini and Copilot adapters)
- `gemini-client-handler.ts` / `copilot-client-handler.ts` — ACP `Client` implementations per agent
- `gemini-event-mapper.ts` / `copilot-event-mapper.ts` — map agent-specific NDJSON events to `AgendoEventPayload`

Adapters expose a standard interface: they parse stdout into `AgendoEventPayload`s and handle permission prompts. `adapter-factory.ts` selects the right adapter based on `agent.binaryName`.

## Critical Rules

1. **Port 4100** for Next.js dev server (3000 is taken by another app)
2. **NEVER run `pnpm dev` directly in production** — use `pm2 restart agendo` (or `pnpm dev:all` in local dev only)
3. **No `any` types** — TypeScript strict mode, always
4. **`params` is async** in Next.js 16 — always `const { id } = await params;`
5. **Named exports only** (except Next.js pages/layouts/routes)
6. **03-data-model.md field names are final** — do not rename columns or types
7. **`AgentCapability`** is the type name (not `Capability`), `cap.label` (not `cap.name`), `cap.dangerLevel` (not `cap.level`)
8. **Worker build uses esbuild** (not `tsc` — OOMs). Use `pnpm worker:build`.
9. **MCP server**: no `@/` path aliases — bundled separately with esbuild (`pnpm build:mcp`)
10. **Strip `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`** env vars before spawning agent subprocesses
11. **Version tags** — always use `scripts/release.sh` to create releases (never manual `npm version` or `git tag`)
12. **Upgrades** — always use `scripts/upgrade.sh` (never raw `git pull` in production)
13. **Migrations** — only run `pnpm db:generate --name <description>` when `schema.ts` actually changes between releases. Never create migration files manually. One migration file per release at most. Fresh installs use `pnpm db:setup` (push, ignores migration files); upgrades use `pnpm db:migrate` (applies only new files since the baseline).

## Service Patterns

All services follow the same structure:

```typescript
import { db } from '@/lib/db';
import { tableName } from '@/lib/db/schema';
import { eq, and, desc } from 'drizzle-orm';

export async function listItems(filters?: { status?: string }) {
  return db.select().from(tableName).where(/* conditions */);
}
```

## API Route Patterns

```typescript
import { withErrorBoundary } from '@/lib/api-handler';
import { NextRequest } from 'next/server';

export const GET = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    // ... service call
    return Response.json({ data: result });
  },
);
```

Use `assertUUID(id, 'ResourceName')` (from `api-handler.ts`) before querying — it throws `NotFoundError` for invalid UUIDs.

## TDD Workflow (Mandatory)

All new features MUST follow strict Test-Driven Development:

1. **Red**: Write failing tests FIRST based on planned interfaces/behavior
2. **Verify Red**: Run tests to confirm they fail (no implementation yet)
3. **Green**: Write minimal implementation code to make tests pass
4. **Verify Green**: Run tests to confirm all pass
5. **Refactor**: Clean up if needed, tests must stay green

When using agent teams:

- **tests agent runs first** — writes all failing tests, confirms red
- **implementation agents run second** — write code to make tests pass
- Never write tests and implementation in parallel

Tests live at `src/**/__tests__/*.test.ts` or `src/**/*.test.ts`, run with vitest (node environment, no jsdom).
