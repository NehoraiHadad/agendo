# Agent Monitor — Project Instructions

## Project Overview

Agent Monitor is a Next.js 16 application for managing AI coding agents (Claude, Codex, Gemini). It provides agent discovery, task management (Kanban), execution orchestration with bidirectional communication, live log streaming, and an MCP server for agent-initiated tasks.

## Source of Truth

- `planning/03-data-model.md` — THE authority for all table names, column names, enum values, and TypeScript types. When in doubt, check this file.
- `planning/02-architecture.md` — system architecture and confirmed technical decisions
- `planning/01-brainstorm-synthesis.md` — confirmed design decisions
- `plan/phase-*.md` — detailed implementation plans per phase

## Tech Stack

- **Framework**: Next.js 16 (App Router, React 19, TypeScript strict)
- **Database**: PostgreSQL + Drizzle ORM (no Supabase, no raw SQL)
- **Queue**: pg-boss
- **Process manager**: PM2
- **UI**: shadcn/ui + Tailwind CSS
- **State**: Zustand (client), Server Components (server)
- **Real-time**: SSE (board updates, log streaming), socket.io (terminal)
- **Terminal**: xterm.js v6 (@xterm/\* scoped packages) + node-pty
- **MCP**: @modelcontextprotocol/sdk (stdio transport)

## Critical Rules

1. **Port 4100** for Next.js dev server (3000 is taken by another app)
2. **NEVER run `pnpm dev` directly** — use `pm2 restart agent-monitor`
3. **No `any` types** — TypeScript strict mode, always
4. **`params` is async** in Next.js 16 — always `const { id } = await params;`
5. **Named exports only** (except Next.js pages/layouts/routes)
6. **03-data-model.md field names are final** — do not rename columns or types
7. **C-09 is a FALSE POSITIVE** — `execution.mode` column EXISTS at data-model line 214
8. **No `execution_logs` table** — log fields are on the `executions` table
9. **No `pending` execution status** — valid: queued, running, cancelling, succeeded, failed, cancelled, timed_out
10. **`AgentCapability`** is the type name (not `Capability`), `cap.label` (not `cap.name`), `cap.dangerLevel` (not `cap.level`)

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

## PM2 Services

| Service         | Port | PM2 Name               |
| --------------- | ---- | ---------------------- |
| Next.js app     | 4100 | agent-monitor          |
| Worker          | —    | agent-monitor-worker   |
| Terminal server | 4101 | agent-monitor-terminal |
