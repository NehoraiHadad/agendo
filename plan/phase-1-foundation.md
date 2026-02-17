# Phase 1: Foundation + App Shell

> **Goal**: Project scaffolding, full DB schema, worker skeleton, navigable app shell with empty pages.
> **Prerequisites**: Node.js >= 20.9.0, PostgreSQL running locally, pnpm installed.

---

## Packages to Install

```bash
# Core (dependencies)
pnpm add next@latest react@latest react-dom@latest typescript drizzle-orm pg zod tsx pg-boss sonner date-fns

# Dev dependencies
pnpm add -D drizzle-kit @types/pg @types/node @types/react @types/react-dom esbuild

# UI dependencies
pnpm add class-variance-authority tailwind-merge clsx lucide-react

# Testing
pnpm add -D vitest @vitest/coverage-v8
```

---

## Step 1: Scaffold Next.js 16 Project

**File**: `/home/ubuntu/projects/agent-monitor/` (project root)

```bash
pnpm create next-app@latest agent-monitor --typescript --tailwind --app --src-dir
cd agent-monitor
```

After scaffolding, verify `package.json` has `next@16.x`, `react@19.x`, `react-dom@19.x`.

**Modify** `/home/ubuntu/projects/agent-monitor/next.config.ts`:

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Turbopack is default in Next.js 16 -- no flag needed
  serverExternalPackages: ['pg'],
};

export default nextConfig;
```

**Modify** `/home/ubuntu/projects/agent-monitor/package.json` scripts:

```json
{
  "scripts": {
    "dev": "next dev --port 4100",
    "build": "next build",
    "start": "next start --port 4100",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "worker:dev": "tsx watch src/worker/index.ts",
    "worker:build": "tsc -p tsconfig.worker.json",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

---

## Step 2: Environment Configuration

**Create** `/home/ubuntu/projects/agent-monitor/.env.local`:

```env
DATABASE_URL=postgresql://agent_monitor:agent_monitor@localhost:5432/agent_monitor
WORKER_ID=worker-1
WORKER_POLL_INTERVAL_MS=2000
WORKER_MAX_CONCURRENT_JOBS=3
LOG_DIR=/data/agent-monitor/logs
STALE_JOB_THRESHOLD_MS=120000
HEARTBEAT_INTERVAL_MS=30000
ALLOWED_WORKING_DIRS=/home/ubuntu/projects:/tmp
NODE_ENV=development
PORT=4100
TERMINAL_WS_PORT=4101
JWT_SECRET=dev-secret-change-in-production
```

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/config.ts`:

```typescript
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  WORKER_ID: z.string().default('worker-1'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().default(2000),
  WORKER_MAX_CONCURRENT_JOBS: z.coerce.number().default(3),
  LOG_DIR: z.string().default('/data/agent-monitor/logs'),
  STALE_JOB_THRESHOLD_MS: z.coerce.number().default(120000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(30000),
  ALLOWED_WORKING_DIRS: z.string().default('/home/ubuntu/projects:/tmp'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4100),
  TERMINAL_WS_PORT: z.coerce.number().default(4101),
  JWT_SECRET: z.string().min(16),
  MCP_SERVER_PATH: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment configuration:');
    console.error(result.error.format());
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();

/** Parsed ALLOWED_WORKING_DIRS as array of absolute paths */
export const allowedWorkingDirs = config.ALLOWED_WORKING_DIRS.split(':').filter(Boolean);
```

---

## Step 3: Database Schema

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/db/schema.ts`:

Copy the full schema from `planning/03-data-model.md` (the Drizzle ORM TypeScript block). The file contains:

- **Enums**: `taskStatusEnum`, `executionStatusEnum`, `interactionModeEnum`, `agentKindEnum`, `capabilitySourceEnum`, `discoveryMethodEnum`
- **Tables**: `agents`, `agentCapabilities`, `tasks`, `taskDependencies`, `executions`, `taskEvents`, `workerHeartbeats`, `workerConfig`
- **Indexes**: 9 indexes for query performance (see 03-data-model.md Index Summary)
- **Check constraints**: `capability_mode_consistency` on `agentCapabilities`, `no_self_dependency` on `taskDependencies`

All imports from `drizzle-orm/pg-core` and `drizzle-orm`. See `planning/03-data-model.md` lines 38-289 for the complete copy-paste-ready schema.

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/db/index.ts`:

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';
import { config } from '../config';

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema });
export { pool };
```

**Create** `/home/ubuntu/projects/agent-monitor/drizzle.config.ts`:

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

**Run migration**:

```bash
pnpm db:generate
pnpm db:migrate
```

---

## Step 4: Type Definitions

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/types.ts`:

```typescript
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type * as schema from './db/schema';

// ---- DB row types ----
export type Agent = InferSelectModel<typeof schema.agents>;
export type AgentCapability = InferSelectModel<typeof schema.agentCapabilities>;
export type Task = InferSelectModel<typeof schema.tasks>;
export type Execution = InferSelectModel<typeof schema.executions>;
export type TaskEvent = InferSelectModel<typeof schema.taskEvents>;
export type WorkerHeartbeat = InferSelectModel<typeof schema.workerHeartbeats>;

export type NewAgent = InferInsertModel<typeof schema.agents>;
export type NewCapability = InferInsertModel<typeof schema.agentCapabilities>;
export type NewTask = InferInsertModel<typeof schema.tasks>;
export type NewExecution = InferInsertModel<typeof schema.executions>;

// ---- Enum value types ----
export type TaskStatus = (typeof schema.taskStatusEnum.enumValues)[number];
export type ExecutionStatus = (typeof schema.executionStatusEnum.enumValues)[number];
export type InteractionMode = (typeof schema.interactionModeEnum.enumValues)[number];
export type AgentKind = (typeof schema.agentKindEnum.enumValues)[number];
export type CapabilitySource = (typeof schema.capabilitySourceEnum.enumValues)[number];
export type DiscoveryMethod = (typeof schema.discoveryMethodEnum.enumValues)[number];

// ---- Domain types ----

/** agents.session_config */
export interface AgentSessionConfig {
  sessionIdSource: 'json_field' | 'filesystem' | 'list_command' | 'none';
  sessionIdField?: string;
  sessionFileGlob?: string;
  listSessionsCommand?: string[];
  listSessionsPattern?: string;
  resumeFlags?: string[];
  continueFlags?: string[];
  bidirectionalProtocol?: 'stream-json' | 'app-server' | 'tmux';
}

/** agents.metadata */
export interface AgentMetadata {
  icon?: string;
  color?: string;
  description?: string;
  homepage?: string;
}

/** tasks.input_context */
export interface TaskInputContext {
  workingDir?: string;
  envOverrides?: Record<string, string>;
  args?: Record<string, unknown>;
  promptAdditions?: string;
}

/** agent_capabilities.args_schema */
export interface JsonSchemaObject {
  type?: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** SSE log streaming event types */
export type SseLogEvent =
  | { type: 'status'; status: ExecutionStatus }
  | { type: 'catchup'; content: string }
  | { type: 'log'; content: string; stream: 'stdout' | 'stderr' | 'system' }
  | { type: 'done'; status: ExecutionStatus; exitCode: number | null }
  | { type: 'error'; message: string };

/** Task with related data for detail views */
export interface TaskWithDetails extends Task {
  assigneeAgent: Agent | null;
  subtasks: Task[];
  dependsOn: Task[];
  blockedBy: Task[];
  recentExecutions: Execution[];
}

/** Execution with related data */
export interface ExecutionWithDetails extends Execution {
  agent: Agent;
  capability: AgentCapability;
  task: Task;
}
```

---

## Step 5: Error Hierarchy

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/errors.ts`:

```typescript
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    statusCode: number,
    code: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.context = context;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.context && { context: this.context }),
      },
    };
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} with id '${id}' not found` : `${resource} not found`,
      404,
      'NOT_FOUND',
      { resource, id },
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 422, 'VALIDATION_ERROR', context);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 409, 'CONFLICT', context);
  }
}

export class SafetyViolationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 403, 'SAFETY_VIOLATION', context);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 408, 'TIMEOUT', context);
  }
}

/** Type guard for AppError instances */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
```

---

## Step 6: State Machines

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/state-machines.ts`:

```typescript
import type { TaskStatus, ExecutionStatus } from './types';

/**
 * Valid task status transitions.
 * Key = current status, Value = set of valid next statuses.
 */
export const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  todo: new Set(['in_progress', 'cancelled', 'blocked']),
  in_progress: new Set(['done', 'blocked', 'cancelled', 'todo']),
  blocked: new Set(['todo', 'in_progress', 'cancelled']),
  done: new Set(['todo']),       // reopen
  cancelled: new Set(['todo']),  // reopen
};

/**
 * Valid execution status transitions.
 * Key = current status, Value = set of valid next statuses.
 */
export const EXECUTION_TRANSITIONS: Record<ExecutionStatus, ReadonlySet<ExecutionStatus>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['cancelling', 'succeeded', 'failed', 'timed_out']),
  cancelling: new Set(['cancelled', 'failed']),
  succeeded: new Set(),    // terminal
  failed: new Set(),       // terminal
  cancelled: new Set(),    // terminal
  timed_out: new Set(),    // terminal
};

/** Terminal statuses that cannot transition further */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set();
// Note: tasks have no truly terminal states -- done and cancelled can reopen to todo

export const TERMINAL_EXECUTION_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
  'succeeded', 'failed', 'cancelled', 'timed_out',
]);

/**
 * Check if a status transition is valid.
 * @returns true if transitioning from `current` to `next` is allowed
 */
export function isValidTaskTransition(current: TaskStatus, next: TaskStatus): boolean {
  return TASK_TRANSITIONS[current].has(next);
}

export function isValidExecutionTransition(current: ExecutionStatus, next: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[current].has(next);
}

/**
 * Check if an execution status is terminal (no further transitions possible).
 */
export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.has(status);
}
```

---

## Step 7: API Handler Wrapper

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/api-handler.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { AppError } from './errors';

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<NextResponse>;

/**
 * Wraps an API route handler with consistent error handling.
 * - AppError subclasses map to their HTTP status code
 * - ZodError returns 422 with field-level details
 * - Unknown errors return 500 with no internal details exposed
 */
export function withErrorBoundary(handler: RouteHandler): RouteHandler {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof AppError) {
        return NextResponse.json(error.toJSON(), { status: error.statusCode });
      }

      if (error instanceof ZodError) {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Request validation failed',
              context: { issues: error.issues },
            },
          },
          { status: 422 },
        );
      }

      console.error('Unhandled API error:', error);
      return NextResponse.json(
        {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
          },
        },
        { status: 500 },
      );
    }
  };
}
```

---

## Step 8: API Types and Client Helper

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/api-types.ts`:

```typescript
/** Successful single-item response */
export interface ApiResponse<T> {
  data: T;
}

/** Successful list response with pagination metadata */
export interface ApiListResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
  };
}

/** Error response */
export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    context?: Record<string, unknown>;
  };
}

/**
 * Type-safe fetch wrapper for internal API calls from client components.
 * Throws on non-2xx responses with the error body.
 */
export async function apiFetch<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  const body = await response.json();

  if (!response.ok) {
    const errorBody = body as ApiErrorResponse;
    throw new Error(errorBody.error?.message ?? 'Request failed');
  }

  return body as T;
}
```

---

## Step 9: Worker Queue Module (pg-boss)

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/worker/queue.ts`:

```typescript
import PgBoss, { type Job } from 'pg-boss';
import { config } from '../config';

/** Job data shape for the execute-capability queue */
export interface ExecuteCapabilityJobData {
  executionId: string;
  capabilityId: string;
  agentId: string;
  args: Record<string, unknown>;
}

const QUEUE_NAME = 'execute-capability';

let bossInstance: PgBoss | null = null;

/**
 * Get or create the singleton pg-boss instance.
 * pg-boss auto-creates its own schema (`pgboss`) on start.
 */
export async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;

  bossInstance = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: 'pgboss',
  });

  await bossInstance.start();
  return bossInstance;
}

/**
 * Enqueue a capability execution job.
 * Called from API routes / server actions.
 */
export async function enqueueExecution(data: ExecuteCapabilityJobData): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(QUEUE_NAME, data, {
    expireInMinutes: 45,
    retryLimit: 2,
    retryDelay: 30,
  });
}

/**
 * Register the worker handler for capability execution jobs.
 * Called from worker/index.ts on startup.
 */
export async function registerWorker(
  handler: (job: Job<ExecuteCapabilityJobData>) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  await boss.work<ExecuteCapabilityJobData>(
    QUEUE_NAME,
    {
      teamSize: config.WORKER_MAX_CONCURRENT_JOBS,
      teamConcurrency: 1,
    },
    handler,
  );
}

/**
 * Gracefully stop pg-boss (drain active jobs, stop polling).
 */
export async function stopBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop({ graceful: true, timeout: 10000 });
    bossInstance = null;
  }
}
```

---

## Step 10: Worker Entry Point

**Create** `/home/ubuntu/projects/agent-monitor/src/worker/index.ts`:

```typescript
import { type Job } from 'pg-boss';
import { db, pool } from '../lib/db/index';
import { executions, workerHeartbeats } from '../lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { config } from '../lib/config';
import {
  type ExecuteCapabilityJobData,
  registerWorker,
  stopBoss,
} from '../lib/worker/queue';
import { checkDiskSpace } from './disk-check';
import { reconcileZombies } from './zombie-reconciler';

const WORKER_ID = config.WORKER_ID;

async function handleJob(job: Job<ExecuteCapabilityJobData>): Promise<void> {
  const { executionId } = job.data;
  console.log(`[worker] Claimed job for execution ${executionId}`);

  // Phase 1: stub -- mark as running, wait 1s, mark as succeeded
  await db
    .update(executions)
    .set({
      status: 'running',
      workerId: WORKER_ID,
      startedAt: new Date(),
      heartbeatAt: new Date(),
    })
    .where(eq(executions.id, executionId));

  // Simulate work (replaced with real execution runner in Phase 4)
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Cancellation race guard: only complete if still running
  const result = await db
    .update(executions)
    .set({
      status: 'succeeded',
      endedAt: new Date(),
      exitCode: 0,
    })
    .where(and(eq(executions.id, executionId), eq(executions.status, 'running')))
    .returning({ id: executions.id });

  if (result.length === 0) {
    // Status changed to 'cancelling' mid-execution -- respect cancellation
    await db
      .update(executions)
      .set({ status: 'cancelled', endedAt: new Date() })
      .where(
        and(eq(executions.id, executionId), eq(executions.status, 'cancelling')),
      );
    console.log(`[worker] Execution ${executionId} was cancelled during run`);
  } else {
    console.log(`[worker] Execution ${executionId} completed successfully`);
  }
}

async function updateHeartbeat(): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      workerId: WORKER_ID,
      lastSeenAt: new Date(),
      currentExecutions: 0,
      metadata: {},
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: { lastSeenAt: new Date() },
    });
}

async function main(): Promise<void> {
  console.log(`[worker] Starting worker ${WORKER_ID}...`);

  // Pre-flight: disk space check
  const hasDiskSpace = await checkDiskSpace(config.LOG_DIR);
  if (!hasDiskSpace) {
    console.error('[worker] Insufficient disk space (< 5GB free). Refusing to start.');
    process.exit(1);
  }

  // Pre-flight: zombie process reconciliation
  await reconcileZombies(WORKER_ID);

  // Register the job handler
  await registerWorker(handleJob);
  console.log(`[worker] Listening for jobs (max ${config.WORKER_MAX_CONCURRENT_JOBS} concurrent)...`);

  // Heartbeat loop
  const heartbeatInterval = setInterval(updateHeartbeat, config.HEARTBEAT_INTERVAL_MS);
  await updateHeartbeat(); // initial beat

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[worker] Received ${signal}, shutting down...`);
    clearInterval(heartbeatInterval);
    await stopBoss();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[worker] Fatal error:', err);
  process.exit(1);
});
```

**Create** `/home/ubuntu/projects/agent-monitor/src/worker/zombie-reconciler.ts`:

```typescript
import { db } from '../lib/db/index';
import { executions } from '../lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

/**
 * On cold start: find executions that were 'running' or 'cancelling'
 * for this worker, check if their PIDs are still alive, and mark
 * dead ones as failed.
 */
export async function reconcileZombies(workerId: string): Promise<void> {
  const orphaned = await db
    .select({ id: executions.id, pid: executions.pid })
    .from(executions)
    .where(
      and(
        eq(executions.workerId, workerId),
        inArray(executions.status, ['running', 'cancelling']),
      ),
    );

  if (orphaned.length === 0) {
    console.log('[worker] No orphaned executions found.');
    return;
  }

  console.log(`[worker] Found ${orphaned.length} orphaned execution(s). Reconciling...`);

  for (const exec of orphaned) {
    const isAlive = exec.pid ? isPidAlive(exec.pid) : false;

    if (!isAlive) {
      await db
        .update(executions)
        .set({
          status: 'failed',
          endedAt: new Date(),
          error: 'Worker restarted, execution orphaned',
        })
        .where(eq(executions.id, exec.id));
      console.log(`[worker] Marked execution ${exec.id} as failed (orphaned).`);
    } else {
      // Rare: PID still alive after restart. Send SIGTERM, handle normally.
      console.log(`[worker] Execution ${exec.id} PID ${exec.pid} still alive. Sending SIGTERM.`);
      try {
        process.kill(exec.pid!, 'SIGTERM');
      } catch {
        // PID may have died between check and kill -- that's fine
      }
    }
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = check existence, don't send signal
    return true;
  } catch {
    return false;
  }
}
```

**Create** `/home/ubuntu/projects/agent-monitor/src/worker/disk-check.ts`:

```typescript
import { statfs } from 'node:fs/promises';
import { mkdirSync, existsSync } from 'node:fs';

const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

/**
 * Check if there is sufficient disk space in the log directory.
 * Creates the directory if it doesn't exist.
 * @returns true if >= 5GB free space
 */
export async function checkDiskSpace(logDir: string): Promise<boolean> {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const stats = await statfs(logDir);
  const freeBytes = stats.bavail * stats.bsize;
  const freeGB = (freeBytes / (1024 * 1024 * 1024)).toFixed(2);

  console.log(`[worker] Disk space available: ${freeGB} GB`);
  return freeBytes >= MIN_FREE_BYTES;
}
```

---

## Step 11: Worker TypeScript Config

**Create** `/home/ubuntu/projects/agent-monitor/tsconfig.worker.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "module": "commonjs",
    "moduleResolution": "node",
    "noEmit": false,
    "declaration": false,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": [
    "src/worker/**/*.ts",
    "src/lib/**/*.ts"
  ],
  "exclude": [
    "src/app/**",
    "src/components/**",
    "src/lib/hooks/**",
    "src/lib/store/**",
    "node_modules"
  ]
}
```

---

## Step 12: API Route Stubs

**Create** `/home/ubuntu/projects/agent-monitor/src/app/api/tasks/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';

export const GET = withErrorBoundary(async () => {
  return NextResponse.json({ data: [], meta: { total: 0, page: 1, pageSize: 50 } });
});

export const POST = withErrorBoundary(async () => {
  return NextResponse.json({ data: {} }, { status: 501 });
});
```

**Create** `/home/ubuntu/projects/agent-monitor/src/app/api/agents/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';

export const GET = withErrorBoundary(async () => {
  return NextResponse.json({ data: [], meta: { total: 0, page: 1, pageSize: 50 } });
});

export const POST = withErrorBoundary(async () => {
  return NextResponse.json({ data: {} }, { status: 501 });
});
```

**Create** `/home/ubuntu/projects/agent-monitor/src/app/api/executions/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { withErrorBoundary } from '@/lib/api-handler';

export const GET = withErrorBoundary(async () => {
  return NextResponse.json({ data: [], meta: { total: 0, page: 1, pageSize: 50 } });
});

export const POST = withErrorBoundary(async () => {
  return NextResponse.json({ data: {} }, { status: 501 });
});
```

---

## Step 13: Initialize shadcn/ui

```bash
pnpm dlx shadcn@latest init
```

When prompted:
- Style: Default
- Base color: Zinc
- CSS variables: Yes

Then add components:

```bash
npx shadcn@latest add button badge separator sheet scroll-area skeleton tooltip dialog select input textarea card toggle table command label
```

This creates components in `/home/ubuntu/projects/agent-monitor/src/components/ui/`.

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/utils.ts` (if not created by shadcn):

```typescript
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

---

## Step 14: App Shell Layout

**Create** `/home/ubuntu/projects/agent-monitor/src/components/layout/sidebar.tsx`:

```typescript
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ListTodo,
  Bot,
  Play,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/tasks', label: 'Tasks', icon: ListTodo },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/executions', label: 'Executions', icon: Play },
];

export function Sidebar() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r bg-muted/40 transition-all duration-200',
        isCollapsed ? 'w-16' : 'w-56',
      )}
    >
      <div className="flex h-14 items-center border-b px-4">
        {!isCollapsed && (
          <span className="text-sm font-semibold">Agent Monitor</span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className={cn('ml-auto h-8 w-8', isCollapsed && 'mx-auto')}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </Button>
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
          const isActive = pathname === item.href ||
            (item.href !== '/' && pathname.startsWith(item.href));

          const linkContent = (
            <Link
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                isCollapsed && 'justify-center px-2',
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!isCollapsed && <span>{item.label}</span>}
            </Link>
          );

          if (isCollapsed) {
            return (
              <Tooltip key={item.href} delayDuration={0}>
                <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          }

          return <div key={item.href}>{linkContent}</div>;
        })}
      </nav>
    </aside>
  );
}
```

**Create** `/home/ubuntu/projects/agent-monitor/src/components/layout/app-shell.tsx`:

```typescript
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sidebar } from './sidebar';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </TooltipProvider>
  );
}
```

**Create** `/home/ubuntu/projects/agent-monitor/src/app/(dashboard)/layout.tsx`:

```typescript
import { AppShell } from '@/components/layout/app-shell';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
```

---

## Step 15: Empty Page Shells

**Create** `/home/ubuntu/projects/agent-monitor/src/app/(dashboard)/page.tsx`:

```typescript
export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Dashboard</h1>
      <p className="mt-2 text-muted-foreground">
        Agent Monitor overview. Stats and activity will appear here.
      </p>
    </div>
  );
}
```

**Create** `/home/ubuntu/projects/agent-monitor/src/app/(dashboard)/tasks/page.tsx`:

```typescript
export default function TasksPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Tasks</h1>
      <p className="mt-2 text-muted-foreground">
        Kanban board will appear here.
      </p>
    </div>
  );
}
```

**Create** `/home/ubuntu/projects/agent-monitor/src/app/(dashboard)/agents/page.tsx`:

```typescript
export default function AgentsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Agents</h1>
      <p className="mt-2 text-muted-foreground">
        Agent registry and discovery will appear here.
      </p>
    </div>
  );
}
```

**Create** `/home/ubuntu/projects/agent-monitor/src/app/(dashboard)/executions/page.tsx`:

```typescript
export default function ExecutionsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Executions</h1>
      <p className="mt-2 text-muted-foreground">
        Execution history will appear here.
      </p>
    </div>
  );
}
```

---

## Step 16: Update Root Layout

**Modify** `/home/ubuntu/projects/agent-monitor/src/app/layout.tsx`:

Ensure the root layout has proper metadata and the Tailwind global styles. The scaffolded version should already have this, but verify:

```typescript
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Agent Monitor',
  description: 'CLI agent orchestration and task management',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>{children}</body>
    </html>
  );
}
```

---

## Step 17: PM2 Configuration

**Modify** `/home/ubuntu/projects/ecosystem.config.js` to add these entries:

```javascript
// Add to the apps array in the existing ecosystem.config.js:
{
  name: 'agent-monitor',
  cwd: '/home/ubuntu/projects/agent-monitor',
  script: 'pnpm',
  args: 'start',
  interpreter: 'none',
  env: {
    PORT: '4100',
    NODE_OPTIONS: '--max-old-space-size=1024',
    NODE_ENV: 'production',
  },
  max_restarts: 5,
},
{
  name: 'agent-monitor-worker',
  cwd: '/home/ubuntu/projects/agent-monitor',
  script: 'node',
  args: 'dist/worker/index.js',
  env: {
    NODE_OPTIONS: '--max-old-space-size=512',
    NODE_ENV: 'production',
  },
  max_restarts: 10,
},
```

For **development**, use:
- Next.js: `pm2 restart agent-monitor` (or the PM2 dev configuration)
- Worker: `pnpm worker:dev` (tsx watch for hot-reload during development)

---

## Step 18: Vitest Configuration

**Create** `/home/ubuntu/projects/agent-monitor/vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/lib/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

---

## Step 19: Unit Tests -- State Machines

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/__tests__/state-machines.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  isValidTaskTransition,
  isValidExecutionTransition,
  isTerminalExecutionStatus,
  TASK_TRANSITIONS,
  EXECUTION_TRANSITIONS,
} from '../state-machines';

describe('Task Status Transitions', () => {
  it('allows todo -> in_progress', () => {
    expect(isValidTaskTransition('todo', 'in_progress')).toBe(true);
  });

  it('allows todo -> cancelled', () => {
    expect(isValidTaskTransition('todo', 'cancelled')).toBe(true);
  });

  it('allows todo -> blocked', () => {
    expect(isValidTaskTransition('todo', 'blocked')).toBe(true);
  });

  it('rejects todo -> done (must go through in_progress)', () => {
    expect(isValidTaskTransition('todo', 'done')).toBe(false);
  });

  it('allows in_progress -> done', () => {
    expect(isValidTaskTransition('in_progress', 'done')).toBe(true);
  });

  it('allows in_progress -> todo (revert)', () => {
    expect(isValidTaskTransition('in_progress', 'todo')).toBe(true);
  });

  it('allows done -> todo (reopen)', () => {
    expect(isValidTaskTransition('done', 'todo')).toBe(true);
  });

  it('rejects done -> in_progress (must reopen to todo first)', () => {
    expect(isValidTaskTransition('done', 'in_progress')).toBe(false);
  });

  it('allows cancelled -> todo (reopen)', () => {
    expect(isValidTaskTransition('cancelled', 'todo')).toBe(true);
  });

  it('rejects cancelled -> done', () => {
    expect(isValidTaskTransition('cancelled', 'done')).toBe(false);
  });

  it('allows blocked -> todo', () => {
    expect(isValidTaskTransition('blocked', 'todo')).toBe(true);
  });

  it('allows blocked -> in_progress', () => {
    expect(isValidTaskTransition('blocked', 'in_progress')).toBe(true);
  });
});

describe('Execution Status Transitions', () => {
  it('allows queued -> running', () => {
    expect(isValidExecutionTransition('queued', 'running')).toBe(true);
  });

  it('allows queued -> cancelled', () => {
    expect(isValidExecutionTransition('queued', 'cancelled')).toBe(true);
  });

  it('rejects queued -> succeeded', () => {
    expect(isValidExecutionTransition('queued', 'succeeded')).toBe(false);
  });

  it('allows running -> cancelling', () => {
    expect(isValidExecutionTransition('running', 'cancelling')).toBe(true);
  });

  it('allows running -> succeeded', () => {
    expect(isValidExecutionTransition('running', 'succeeded')).toBe(true);
  });

  it('allows running -> failed', () => {
    expect(isValidExecutionTransition('running', 'failed')).toBe(true);
  });

  it('allows running -> timed_out', () => {
    expect(isValidExecutionTransition('running', 'timed_out')).toBe(true);
  });

  it('allows cancelling -> cancelled', () => {
    expect(isValidExecutionTransition('cancelling', 'cancelled')).toBe(true);
  });

  it('allows cancelling -> failed', () => {
    expect(isValidExecutionTransition('cancelling', 'failed')).toBe(true);
  });

  it('rejects cancelling -> succeeded', () => {
    expect(isValidExecutionTransition('cancelling', 'succeeded')).toBe(false);
  });
});

describe('Terminal Execution Statuses', () => {
  it('succeeded is terminal', () => {
    expect(isTerminalExecutionStatus('succeeded')).toBe(true);
  });

  it('failed is terminal', () => {
    expect(isTerminalExecutionStatus('failed')).toBe(true);
  });

  it('cancelled is terminal', () => {
    expect(isTerminalExecutionStatus('cancelled')).toBe(true);
  });

  it('timed_out is terminal', () => {
    expect(isTerminalExecutionStatus('timed_out')).toBe(true);
  });

  it('running is NOT terminal', () => {
    expect(isTerminalExecutionStatus('running')).toBe(false);
  });

  it('queued is NOT terminal', () => {
    expect(isTerminalExecutionStatus('queued')).toBe(false);
  });

  it('cancelling is NOT terminal', () => {
    expect(isTerminalExecutionStatus('cancelling')).toBe(false);
  });
});

describe('Transition Table Completeness', () => {
  it('every task status has a transition entry', () => {
    const allStatuses = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
    for (const status of allStatuses) {
      expect(TASK_TRANSITIONS).toHaveProperty(status);
    }
  });

  it('every execution status has a transition entry', () => {
    const allStatuses = [
      'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out',
    ] as const;
    for (const status of allStatuses) {
      expect(EXECUTION_TRANSITIONS).toHaveProperty(status);
    }
  });
});
```

---

## Step 20: Unit Tests -- Errors

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/__tests__/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  AppError,
  NotFoundError,
  ValidationError,
  ConflictError,
  SafetyViolationError,
  TimeoutError,
  isAppError,
} from '../errors';

describe('AppError', () => {
  it('creates with correct properties', () => {
    const err = new AppError('test', 500, 'TEST');
    expect(err.message).toBe('test');
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('TEST');
    expect(err.name).toBe('AppError');
  });

  it('serializes to JSON without internal details', () => {
    const err = new AppError('oops', 500, 'INTERNAL');
    const json = err.toJSON();
    expect(json).toEqual({
      error: { code: 'INTERNAL', message: 'oops' },
    });
  });

  it('includes context in JSON when provided', () => {
    const err = new AppError('bad', 400, 'BAD', { field: 'name' });
    const json = err.toJSON();
    expect(json.error.context).toEqual({ field: 'name' });
  });
});

describe('NotFoundError', () => {
  it('creates with resource and id', () => {
    const err = new NotFoundError('Task', 'abc-123');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toContain('Task');
    expect(err.message).toContain('abc-123');
  });

  it('creates with resource only', () => {
    const err = new NotFoundError('Agent');
    expect(err.message).toBe('Agent not found');
  });
});

describe('ValidationError', () => {
  it('has 422 status code', () => {
    const err = new ValidationError('Invalid input');
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});

describe('ConflictError', () => {
  it('has 409 status code', () => {
    const err = new ConflictError('Invalid transition');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });
});

describe('SafetyViolationError', () => {
  it('has 403 status code', () => {
    const err = new SafetyViolationError('Working dir not in allowlist');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('SAFETY_VIOLATION');
  });
});

describe('TimeoutError', () => {
  it('has 408 status code', () => {
    const err = new TimeoutError('Execution timed out');
    expect(err.statusCode).toBe(408);
    expect(err.code).toBe('TIMEOUT');
  });
});

describe('isAppError', () => {
  it('returns true for AppError instances', () => {
    expect(isAppError(new AppError('x', 500, 'X'))).toBe(true);
    expect(isAppError(new NotFoundError('x'))).toBe(true);
    expect(isAppError(new ValidationError('x'))).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError('error')).toBe(false);
    expect(isAppError({ message: 'x' })).toBe(false);
  });
});
```

---

## Step 21: Log Retention Seed Data

After migration, seed the `worker_config` table with the retention setting:

**Create** `/home/ubuntu/projects/agent-monitor/src/lib/db/seed.ts`:

```typescript
import { db } from './index';
import { workerConfig } from './schema';

export async function seedWorkerConfig(): Promise<void> {
  await db
    .insert(workerConfig)
    .values([
      { key: 'log_retention_days', value: 30 },
      { key: 'max_concurrent_ai_agents', value: 3 },
    ])
    .onConflictDoNothing();

  console.log('[seed] Worker config seeded.');
}
```

Add a script to `package.json`:

```json
"db:seed": "tsx src/lib/db/seed.ts"
```

---

## Testing Checklist

| Test | File | What It Verifies |
|------|------|------------------|
| Task status transitions | `src/lib/__tests__/state-machines.test.ts` | All valid transitions allowed, all invalid transitions rejected |
| Execution status transitions | `src/lib/__tests__/state-machines.test.ts` | Terminal states have empty transition sets, cancelling flow correct |
| Error serialization | `src/lib/__tests__/errors.test.ts` | toJSON produces correct envelope, no internal details exposed |
| isAppError type guard | `src/lib/__tests__/errors.test.ts` | Correctly identifies AppError subclasses, rejects plain errors |
| Transition completeness | `src/lib/__tests__/state-machines.test.ts` | Every enum value has a transition table entry |

Run tests:

```bash
pnpm test
```

---

## Verification

When Phase 1 is complete, verify:

1. **Database**: `pnpm db:generate && pnpm db:migrate` completes without errors. All tables visible in `pnpm db:studio`.

2. **Next.js**: `pnpm dev` starts on port 4100. All pages load:
   - `http://localhost:4100/` (Dashboard)
   - `http://localhost:4100/tasks` (Tasks)
   - `http://localhost:4100/agents` (Agents)
   - `http://localhost:4100/executions` (Executions)
   - Sidebar navigation works, active states highlight correctly.

3. **API stubs**: Each returns `{ data: [] }`:
   - `curl http://localhost:4100/api/tasks`
   - `curl http://localhost:4100/api/agents`
   - `curl http://localhost:4100/api/executions`

4. **Worker**: `pnpm worker:dev` starts, prints heartbeat messages, connects to pg-boss. Manually inserting a queued execution row and enqueuing a pg-boss job should result in the worker claiming and completing it.

5. **Tests**: `pnpm test` passes all unit tests (state machines + errors).

6. **Build**: `pnpm build` succeeds without errors.
