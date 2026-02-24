# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

agendo is a Next.js 16 application for managing AI coding agents (Claude, Codex, Gemini). It provides agent discovery, task management (Kanban), execution orchestration with bidirectional communication, live log streaming, and an MCP server for agent-initiated tasks.

## Source of Truth

- `planning/03-data-model.md` — THE authority for all table names, column names, enum values, and TypeScript types. When in doubt, check this file.
- `planning/02-architecture.md` — system architecture and confirmed technical decisions
- `planning/01-brainstorm-synthesis.md` — confirmed design decisions
- `plan/phase-*.md` — detailed implementation plans per phase

## Commands

```bash
# Development (never run pnpm dev directly — use PM2)
pm2 restart agendo-worker       # restart worker (ALWAYS safe — does not host MCP)
./scripts/safe-restart-agendo.sh  # restart Next.js app SAFELY (waits for sessions to end)
pm2 restart agendo              # ⚠ DANGER during active sessions — kills MCP connection

# Build
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
pnpm db:generate                # generate migration from schema changes
pnpm db:migrate                 # apply migrations
pnpm db:studio                  # open Drizzle Studio (web UI)
pnpm db:seed                    # seed database

# Worker dev (hot-reload, no build needed)
pnpm worker:dev                 # tsx watch for local dev
```

## Tech Stack

- **Framework**: Next.js 16 (App Router, React 19, TypeScript strict)
- **Database**: PostgreSQL + Drizzle ORM (no Supabase, no raw SQL)
- **Queue**: pg-boss v10
- **Process manager**: PM2
- **UI**: shadcn/ui + Tailwind CSS
- **State**: Zustand (client), Server Components (server)
- **Real-time**: SSE (board updates, log streaming), PG NOTIFY (worker↔frontend bridge), socket.io (terminal)
- **Terminal**: xterm.js v6 (`@xterm/*` scoped packages) + node-pty
- **MCP**: `@modelcontextprotocol/sdk` (stdio transport)

## PM2 Services

| Service         | Port | PM2 Name          |
| --------------- | ---- | ----------------- |
| Next.js app     | 4100 | `agendo`          |
| Worker          | —    | `agendo-worker`   |
| Terminal server | 4101 | `agendo-terminal` |

Config: `/home/ubuntu/projects/ecosystem.config.js`. After env changes: `pm2 restart <name> --update-env && pm2 save`. To fully purge old vars: `pm2 delete <name> && pm2 start ecosystem.config.js --only <name>`.

Worker reads env from `ecosystem.config.js` (NOT `.env.local`). The Next.js app reads `.env.local`.

### Safe Restart Patterns

`agendo-worker` **never** hosts the MCP server — always safe to restart:

```bash
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
- `JWT_SECRET` — min 16 chars, used for API auth
- `LOG_DIR` — defaults to `/data/agendo/logs`
- `ALLOWED_WORKING_DIRS` — colon-separated allowed dirs (default `/home/ubuntu/projects:/tmp`)
- `MCP_SERVER_PATH` — path to bundled MCP server (`dist/mcp-server.js`)

## Architecture: Three Processes

The system runs as three cooperating processes:

```
┌─────────────────────────────────────────┐
│  Next.js App (port 4100)                │
│  - API routes (src/app/api/)            │
│  - Kanban UI, session viewer            │
│  - SSE endpoints for real-time push     │
└───────────────┬─────────────────────────┘
                │ pg-boss queues + PG NOTIFY
┌───────────────▼─────────────────────────┐
│  Worker (agendo-worker)                 │
│  - Dequeues execute-capability jobs     │
│  - Dequeues run-session jobs            │
│  - Spawns AI CLI subprocesses           │
│  - Emits AgendoEvents via PG NOTIFY     │
└───────────────┬─────────────────────────┘
                │ stdio transport
┌───────────────▼─────────────────────────┐
│  MCP Server (dist/mcp-server.js)        │
│  - Injected into agent sessions         │
│  - Exposes task management tools        │
│  - Calls agendo API over HTTP           │
└─────────────────────────────────────────┘
```

## Sessions vs Executions

These are distinct concepts handled by different queues and runners:

- **Sessions** (`run-session` queue, `session-runner.ts`): Long-lived AI conversations. The worker spawns the agent CLI process (`session-process.ts`) and keeps it alive for multi-turn interaction. Frontend sends messages via PG NOTIFY (`agendo_control_*`); worker streams `AgendoEvent`s back via PG NOTIFY (`agendo_events_*`). Use POST `/api/sessions`.
- **Executions** (`execute-capability` queue, `execution-runner.ts`): Fire-and-forget CLI commands using `template`-mode capabilities with `command_tokens`. Use POST `/api/executions`.

POST `/api/executions` returns 400 for `prompt`-mode capabilities — those require sessions.

## Real-Time Flow

```
Worker (session-process.ts)
  → publishes AgendoEvent via pg_notify('agendo_events_{sessionId}')
  → SSE endpoint (src/app/api/sessions/[id]/events/route.ts) subscribes
  → pushes to frontend via EventSource
  → React hooks (use-session-stream.ts) update Zustand store
```

Control signals flow in reverse:

```
Frontend sends message
  → POST /api/sessions/[id]/messages
  → pg_notify('agendo_control_{sessionId}', {type:'message', text})
  → Worker reads in session-process.ts via subscribe()
  → Pipes stdin to agent CLI
```

PG NOTIFY payloads >7500 bytes are replaced with a `{type:'ref'}` stub (`src/lib/realtime/pg-notify.ts`).

## Worker Adapter Pattern

Each AI CLI gets an adapter in `src/lib/worker/adapters/`:

- `claude-adapter.ts` — Claude Code CLI (persistent session, no `-p` flag)
- `codex-adapter.ts` — OpenAI Codex CLI
- `gemini-adapter.ts` — Gemini CLI (uses ACP protocol for tool approvals)
- `template-adapter.ts` — Generic CLI with `command_tokens` substitution

Adapters expose a standard interface: they parse stdout into `AgendoEventPayload`s and handle permission prompts. `adapter-factory.ts` selects the right adapter based on `agent.binaryName`.

## Critical Rules

1. **Port 4100** for Next.js dev server (3000 is taken by another app)
2. **NEVER run `pnpm dev` directly** — use `pm2 restart agendo`
3. **No `any` types** — TypeScript strict mode, always
4. **`params` is async** in Next.js 16 — always `const { id } = await params;`
5. **Named exports only** (except Next.js pages/layouts/routes)
6. **03-data-model.md field names are final** — do not rename columns or types
7. **C-09 is a FALSE POSITIVE** — `execution.mode` column EXISTS at data-model line 214
8. **No `execution_logs` table** — log fields are on the `executions` table
9. **No `pending` execution status** — valid: `queued`, `running`, `cancelling`, `succeeded`, `failed`, `cancelled`, `timed_out`
10. **`AgentCapability`** is the type name (not `Capability`), `cap.label` (not `cap.name`), `cap.dangerLevel` (not `cap.level`)
11. **Worker build uses esbuild** (not `tsc` — OOMs). Use `pnpm worker:build`.
12. **MCP server**: no `@/` path aliases — bundled separately with esbuild (`pnpm build:mcp`)
13. **Strip `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`** env vars before spawning agent subprocesses

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
