# AGENTS.md

> Agendo is a Next.js 16 application for managing AI coding agents (Claude, Codex, Gemini). It provides agent discovery, task management (Kanban), execution orchestration with bidirectional communication, live log streaming, and an MCP server for agent-initiated tasks.

## Commands

```bash
# Development
pnpm dev:all                    # starts app + worker + terminal in one command
pnpm dev                        # Next.js dev server (port 4100)
pnpm worker:dev                 # Worker with hot-reload
pnpm terminal:dev               # Terminal server (port 4101)

# Build
pnpm build:all                  # build everything (app + worker + MCP)
pnpm build                      # Next.js production build
pnpm worker:build               # build worker with esbuild (NOT tsc — OOMs)
pnpm build:mcp                  # build MCP server bundle

# Quality
pnpm lint                       # ESLint (zero warnings policy)
pnpm typecheck                  # tsc --noEmit
pnpm format:check               # Prettier check
pnpm test                       # run all tests (vitest)
pnpm vitest run <path>          # single test file

# Database
pnpm db:setup                   # create schema (drizzle-kit push)
pnpm db:migrate                 # apply migrations
pnpm db:seed                    # seed database (agent discovery + capabilities)

# Setup & CI
./scripts/setup.sh              # full setup: deps, DB, build, seed (Linux/macOS)
./scripts/setup.sh --dev        # dev setup: skip build
.\scripts\install.ps1           # full setup (Windows PowerShell)
.\scripts\install.ps1 -Dev      # dev setup (Windows)
./scripts/smoke-test.sh         # post-install verification
./scripts/test-setup-docker.sh          # CI: test setup.sh in Docker (bash, --dev)
./scripts/test-setup-docker.sh --prod   # CI: full production build test
./scripts/test-setup-docker.sh --ps1    # CI: test install.ps1 via PowerShell Core
./scripts/test-setup-docker.sh --all    # CI: all stages (bash + PowerShell)
```

## Tech Stack

- **Framework**: Next.js 16 (App Router, React 19, TypeScript strict)
- **Database**: PostgreSQL + Drizzle ORM
- **Queue**: pg-boss v10
- **UI**: shadcn/ui + Tailwind CSS
- **State**: Zustand (client), Server Components (server)
- **Real-time**: SSE + PG NOTIFY + WebSocket (terminal)
- **Testing**: Vitest (node environment, no jsdom)

## Architecture

Three cooperating processes:

1. **Next.js App** (port 4100) — API routes, Kanban UI, SSE endpoints
2. **Worker** — dequeues jobs via pg-boss, spawns AI CLI subprocesses, emits events via PG NOTIFY
3. **MCP Server** (stdio) — injected into agent sessions, exposes task management tools

## Project Structure

```
src/
  app/                          # Next.js App Router (pages, API routes)
    api/                        # REST API endpoints
    (dashboard)/                # Dashboard pages (board, agents, projects)
  components/                   # React components (shadcn/ui based)
  lib/
    db/                         # Drizzle ORM schema + migrations
    services/                   # Business logic (task-service, session-service, etc.)
    worker/                     # Worker process code
      adapters/                 # AI CLI adapters (claude, codex, gemini, template)
    realtime/                   # PG NOTIFY + SSE utilities
    mcp/                        # MCP server implementation
  hooks/                        # React hooks
  worker/                       # Worker entry point
scripts/                        # Setup, smoke test, deployment scripts
planning/                       # Architecture docs and data model spec
```

## Conventions

- **TypeScript strict** — no `any` types
- **Named exports only** (except Next.js pages/layouts/routes)
- **`params` is async** in Next.js 16 — always `const { id } = await params;`
- **Worker build uses esbuild**, not tsc (tsc OOMs on this project)
- **MCP server** uses no `@/` path aliases — bundled separately with esbuild
- **Zero ESLint warnings** policy — `pnpm lint` must pass clean
- **TDD workflow** — write failing tests first, then implement

## Code Patterns

### Service layer

```typescript
import { db } from '@/lib/db';
import { tableName } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function listItems(filters?: { status?: string }) {
  return db.select().from(tableName).where(/* conditions */);
}
```

### API routes

```typescript
import { withErrorBoundary } from '@/lib/api-handler';
import { NextRequest } from 'next/server';

export const GET = withErrorBoundary(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    return Response.json({ data: result });
  },
);
```

Use `assertUUID(id, 'ResourceName')` before querying.

### Tests

Tests live at `src/**/__tests__/*.test.ts`, run with vitest (node environment).

## Environment Variables

Required (validated with Zod on startup via `src/lib/config.ts`):

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — min 16 chars, used for API auth
- `LOG_DIR` — defaults to `./logs` (relative to project root)
- `ALLOWED_WORKING_DIRS` — colon-separated allowed dirs
- `MCP_SERVER_PATH` — path to bundled MCP server (`dist/mcp-server.js`)
- `AGENDO_URL` — URL the MCP server uses to call back into the Next.js API (default: `http://localhost:4100`)

## Key Domain Concepts

- **Sessions** — long-lived AI conversations (`run-session` queue). Persistent subprocess, multi-turn interaction. Created via POST `/api/sessions`.
- **Executions** — fire-and-forget template/CLI commands (`execute-capability` queue). No persistent process. Created via POST `/api/executions`.
- **Adapters** — per-CLI protocol handlers in `src/lib/worker/adapters/`:
  - `claude-sdk-adapter.ts` — Claude Code CLI (persistent session, no `-p` flag)
  - `codex-app-server-adapter.ts` — OpenAI Codex via `codex app-server` JSON-RPC (NOT `codex exec`)
  - `gemini-adapter.ts` — Gemini CLI via ACP protocol
  - `copilot-adapter.ts` — GitHub Copilot CLI via ACP protocol
- **AgendoEvents** — typed event system for real-time communication (PG NOTIFY + SSE)

## Source of Truth

- `planning/03-data-model.md` — canonical table names, column names, enum values, TypeScript types
- `planning/02-architecture.md` — system architecture decisions
