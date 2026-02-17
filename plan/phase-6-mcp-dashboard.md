# Phase 6: Dashboard + MCP Server + Polish

> **Goal**: Dashboard with live stats, Agent Monitor MCP server (lets AI agents manage tasks), complete schema-form fields, virtual scrolling, loop prevention, polish pass.
>
> **Prerequisites**: Phases 1-5 complete (full CRUD, execution engine, DnD board, SSE).

---

## Packages to Install

```bash
cd /home/ubuntu/projects/agent-monitor
pnpm add @modelcontextprotocol/sdk @tanstack/react-virtual@3
```

---

## Step 1: Dashboard Data Queries

### 1.1 Create dashboard service

**File**: `src/lib/services/dashboard-service.ts`

```typescript
import { db } from '@/lib/db';
import { tasks, executions, taskEvents, agents, workerHeartbeats } from '@/lib/db/schema';
import { eq, sql, and, gt, count, inArray, desc } from 'drizzle-orm';

export interface DashboardStats {
  taskCountsByStatus: Record<string, number>;
  activeExecutions: number;
  queuedExecutions: number;
  failedLast24h: number;
  recentEvents: Array<{
    id: number;
    taskId: string;
    eventType: string;
    actorType: string;
    createdAt: Date;
    payload: Record<string, unknown>;
  }>;
  agentHealth: Array<{
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
    maxConcurrent: number;
    runningCount: number;
  }>;
  workerStatus: {
    isOnline: boolean;
    currentExecutions: number;
    lastSeenAt: Date | null;
  } | null;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  // 1. Task counts by status
  const taskCounts = await db
    .select({
      status: tasks.status,
      count: count(),
    })
    .from(tasks)
    .groupBy(tasks.status);

  const taskCountsByStatus: Record<string, number> = {};
  for (const row of taskCounts) {
    taskCountsByStatus[row.status] = row.count;
  }

  // 2. Active and queued execution counts
  const executionCounts = await db
    .select({
      status: executions.status,
      count: count(),
    })
    .from(executions)
    .where(inArray(executions.status, ['running', 'queued', 'cancelling']))
    .groupBy(executions.status);

  let activeExecutions = 0;
  let queuedExecutions = 0;
  for (const row of executionCounts) {
    if (row.status === 'running' || row.status === 'cancelling') {
      activeExecutions += row.count;
    } else if (row.status === 'queued') {
      queuedExecutions = row.count;
    }
  }

  // 3. Failed executions in last 24h
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [failedRow] = await db
    .select({ count: count() })
    .from(executions)
    .where(and(eq(executions.status, 'failed'), gt(executions.endedAt, twentyFourHoursAgo)));
  const failedLast24h = failedRow?.count ?? 0;

  // 4. Recent task events (last 20)
  const recentEvents = await db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      eventType: taskEvents.eventType,
      actorType: taskEvents.actorType,
      createdAt: taskEvents.createdAt,
      payload: taskEvents.payload,
    })
    .from(taskEvents)
    .orderBy(desc(taskEvents.createdAt))
    .limit(20);

  // 5. Agent health: running execution count vs max_concurrent
  const agentRows = await db
    .select({
      id: agents.id,
      name: agents.name,
      slug: agents.slug,
      isActive: agents.isActive,
      maxConcurrent: agents.maxConcurrent,
    })
    .from(agents)
    .where(eq(agents.isActive, true));

  const agentHealth = await Promise.all(
    agentRows.map(async (agent) => {
      const [runningRow] = await db
        .select({ count: count() })
        .from(executions)
        .where(
          and(
            eq(executions.agentId, agent.id),
            inArray(executions.status, ['running', 'cancelling']),
          ),
        );
      return {
        ...agent,
        runningCount: runningRow?.count ?? 0,
      };
    }),
  );

  // 6. Worker status
  const [workerRow] = await db
    .select()
    .from(workerHeartbeats)
    .orderBy(desc(workerHeartbeats.lastSeenAt))
    .limit(1);

  const workerStatus = workerRow
    ? {
        isOnline: Date.now() - workerRow.lastSeenAt.getTime() < 120_000, // 2 min threshold
        currentExecutions: workerRow.currentExecutions,
        lastSeenAt: workerRow.lastSeenAt,
      }
    : null;

  return {
    taskCountsByStatus,
    activeExecutions,
    queuedExecutions,
    failedLast24h,
    recentEvents,
    agentHealth,
    workerStatus,
  };
}
```

### 1.2 Create dashboard API route

**File**: `src/app/api/dashboard/route.ts`

```typescript
import { NextResponse } from 'next/server';
import { getDashboardStats } from '@/lib/services/dashboard-service';
import { withErrorBoundary } from '@/lib/api-handler';

export const GET = withErrorBoundary(async () => {
  const stats = await getDashboardStats();
  return NextResponse.json({ data: stats });
});
```

---

## Step 2: Dashboard UI Components

### 2.1 Stats grid (RSC)

**File**: `src/components/dashboard/stats-grid.tsx`

```typescript
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ListTodo, Play, Clock, AlertTriangle } from 'lucide-react';
import type { DashboardStats } from '@/lib/services/dashboard-service';

interface StatsGridProps {
  stats: DashboardStats;
}

export function StatsGrid({ stats }: StatsGridProps) {
  const totalTasks = Object.values(stats.taskCountsByStatus).reduce(
    (sum, c) => sum + c,
    0,
  );
  const cards = [
    {
      title: 'Total Tasks',
      value: totalTasks,
      description: `${stats.taskCountsByStatus['todo'] ?? 0} todo, ${stats.taskCountsByStatus['in_progress'] ?? 0} in progress`,
      icon: ListTodo,
    },
    {
      title: 'Active Executions',
      value: stats.activeExecutions,
      description: `${stats.queuedExecutions} queued`,
      icon: Play,
    },
    {
      title: 'Queued',
      value: stats.queuedExecutions,
      description: 'Waiting for worker',
      icon: Clock,
    },
    {
      title: 'Failed (24h)',
      value: stats.failedLast24h,
      description: 'Last 24 hours',
      icon: AlertTriangle,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{card.value}</div>
            <p className="text-xs text-muted-foreground">{card.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

### 2.2 Active executions list (client)

**File**: `src/components/dashboard/active-executions-list.tsx`

```typescript
'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { XCircle } from 'lucide-react';
import type { ExecutionStatus } from '@/lib/types';

interface ActiveExecution {
  id: string;
  taskId: string;
  taskTitle: string;
  agentName: string;
  status: ExecutionStatus;
  startedAt: string;
}

export function ActiveExecutionsList() {
  const [executions, setExecutions] = useState<ActiveExecution[]>([]);

  useEffect(() => {
    const fetchActive = async () => {
      const res = await fetch('/api/executions?status=running,queued,cancelling');
      if (res.ok) {
        const data = await res.json();
        setExecutions(data.data ?? []);
      }
    };

    fetchActive();
    const interval = setInterval(fetchActive, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleCancel = async (id: string) => {
    await fetch(`/api/executions/${id}/cancel`, { method: 'POST' });
  };

  if (executions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No active executions.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {executions.map((exec) => (
        <div
          key={exec.id}
          className="flex items-center justify-between rounded-md border p-3"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{exec.taskTitle}</p>
            <p className="text-xs text-muted-foreground">{exec.agentName}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={exec.status === 'running' ? 'default' : 'secondary'}>
              {exec.status}
            </Badge>
            {exec.status === 'running' && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => handleCancel(exec.id)}
                title="Cancel execution"
              >
                <XCircle className="h-4 w-4 text-destructive" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
```

### 2.3 Recent tasks feed (RSC)

**File**: `src/components/dashboard/recent-tasks-feed.tsx`

```typescript
import type { DashboardStats } from '@/lib/services/dashboard-service';

interface RecentTasksFeedProps {
  events: DashboardStats['recentEvents'];
}

export function RecentTasksFeed({ events }: RecentTasksFeedProps) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">No recent activity.</p>
    );
  }

  return (
    <ul className="space-y-2">
      {events.map((event) => (
        <li key={event.id} className="flex items-start gap-3 text-sm border-b pb-2 last:border-0">
          <span className="shrink-0 h-2 w-2 mt-1.5 rounded-full bg-primary" />
          <div className="flex-1 min-w-0">
            <p className="font-medium">
              {event.eventType.replace(/_/g, ' ')}
            </p>
            <p className="text-xs text-muted-foreground">
              {event.actorType} &middot;{' '}
              {new Date(event.createdAt).toLocaleTimeString()}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
```

### 2.4 Agent health grid (RSC)

**File**: `src/components/dashboard/agent-health-grid.tsx`

```typescript
import { Badge } from '@/components/ui/badge';
import type { DashboardStats } from '@/lib/services/dashboard-service';

interface AgentHealthGridProps {
  agents: DashboardStats['agentHealth'];
}

export function AgentHealthGrid({ agents }: AgentHealthGridProps) {
  if (agents.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">
        No agents registered.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((agent) => {
        const isBusy = agent.runningCount >= agent.maxConcurrent;
        const isIdle = agent.runningCount === 0;

        return (
          <div
            key={agent.id}
            className="flex items-center justify-between rounded-md border p-3"
          >
            <div>
              <p className="text-sm font-medium">{agent.name}</p>
              <p className="text-xs text-muted-foreground">{agent.slug}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {agent.runningCount}/{agent.maxConcurrent}
              </span>
              <Badge
                variant={isBusy ? 'destructive' : isIdle ? 'secondary' : 'default'}
              >
                {isBusy ? 'busy' : isIdle ? 'idle' : 'running'}
              </Badge>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

### 2.5 Dashboard page

**File**: `src/app/(dashboard)/page.tsx` (modify existing)

```typescript
import { getDashboardStats } from '@/lib/services/dashboard-service';
import { StatsGrid } from '@/components/dashboard/stats-grid';
import { ActiveExecutionsList } from '@/components/dashboard/active-executions-list';
import { RecentTasksFeed } from '@/components/dashboard/recent-tasks-feed';
import { AgentHealthGrid } from '@/components/dashboard/agent-health-grid';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  return (
    <div className="p-4 space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <StatsGrid stats={stats} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Active Executions</CardTitle>
          </CardHeader>
          <CardContent>
            <ActiveExecutionsList />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <RecentTasksFeed events={stats.recentEvents} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent Health</CardTitle>
        </CardHeader>
        <CardContent>
          <AgentHealthGrid agents={stats.agentHealth} />
        </CardContent>
      </Card>
    </div>
  );
}
```

---

## Step 3: Agent Monitor MCP Server

### 3.1 Create the MCP server entry point

**File**: `src/lib/mcp/server.ts`

This is the core MCP server that AI agents connect to via stdio transport. Each spawned agent gets its own MCP server process.

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const AGENT_MONITOR_API = process.env.AGENT_MONITOR_URL || 'http://localhost:4100';

/**
 * Helper: call Agent Monitor REST API with error handling.
 */
async function apiCall(path: string, options: RequestInit = {}): Promise<any> {
  const url = `${AGENT_MONITOR_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Agent Monitor API error (${res.status}): ${errorBody}`);
  }

  return res.json();
}

/**
 * Create and configure the Agent Monitor MCP server.
 */
function createAgentMonitorServer(): McpServer {
  const server = new McpServer({
    name: 'agent-monitor',
    version: '1.0.0',
  });

  // -----------------------------------------------------------------------
  // Tool: create_task
  // -----------------------------------------------------------------------
  server.registerTool(
    'create_task',
    {
      title: 'Create Task',
      description:
        'Create a new task on the Agent Monitor Kanban board. ' +
        'Returns the created task ID and title.',
      inputSchema: {
        title: z.string().min(1).max(500).describe('Task title'),
        description: z
          .string()
          .max(5000)
          .optional()
          .describe('Task description (markdown supported)'),
        priority: z
          .enum(['1', '2', '3', '4'])
          .default('3')
          .describe('Priority: 1=critical, 2=high, 3=medium, 4=low'),
        assignee: z
          .string()
          .optional()
          .describe('Agent slug to assign (e.g., "claude", "codex", "gemini")'),
        parentTaskId: z
          .string()
          .uuid()
          .optional()
          .describe('Parent task ID to create this as a subtask'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ title, description, priority, assignee, parentTaskId }) => {
      // Rate limiting is enforced by the MCP server process via
      // AGENT_MONITOR_AGENT_ID env var (see loop-prevention.ts)
      const body: Record<string, unknown> = {
        title,
        description,
        priority: parseInt(priority, 10),
        status: 'todo',
      };
      if (assignee) {
        // Resolve agent slug to UUID
        const agentRes = await apiCall(`/api/agents?slug=${encodeURIComponent(assignee)}`);
        const agents = agentRes.data ?? [];
        if (agents.length === 0) throw new Error(`Agent not found: ${assignee}`);
        body.assigneeAgentId = agents[0].id;
      }
      if (parentTaskId) body.parentTaskId = parentTaskId;

      const result = await apiCall('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const task = result.data;
      return {
        content: [
          {
            type: 'text',
            text: `Task created: #${task.id} "${task.title}" [${task.status}] priority=${task.priority}`,
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------------
  // Tool: update_task
  // -----------------------------------------------------------------------
  server.registerTool(
    'update_task',
    {
      title: 'Update Task',
      description:
        "Update a task's status, assignee, description, or priority. " +
        'Only include fields you want to change.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task ID to update'),
        status: z
          .enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled'])
          .optional()
          .describe('New task status'),
        assignee: z.string().optional().describe('Agent slug to assign'),
        description: z.string().max(5000).optional().describe('Updated task description'),
        priority: z.enum(['1', '2', '3', '4']).optional().describe('Updated priority'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ taskId, status, assignee, description, priority }) => {
      const updates: Record<string, unknown> = {};
      if (status) updates.status = status;
      if (assignee) {
        // Resolve agent slug to UUID
        const agentRes = await apiCall(`/api/agents?slug=${encodeURIComponent(assignee)}`);
        const agents = agentRes.data ?? [];
        if (agents.length === 0) throw new Error(`Agent not found: ${assignee}`);
        updates.assigneeAgentId = agents[0].id;
      }
      if (description !== undefined) updates.description = description;
      if (priority) updates.priority = parseInt(priority, 10);

      const result = await apiCall(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      });

      const task = result.data;
      return {
        content: [
          {
            type: 'text',
            text: `Task #${task.id} updated: status=${task.status}, priority=${task.priority}`,
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------------
  // Tool: list_tasks
  // -----------------------------------------------------------------------
  server.registerTool(
    'list_tasks',
    {
      title: 'List Tasks',
      description:
        'List tasks from the Agent Monitor board. ' +
        'Returns task IDs, titles, statuses, and assignees.',
      inputSchema: {
        status: z
          .enum(['todo', 'in_progress', 'blocked', 'done', 'cancelled', 'all'])
          .default('all')
          .describe('Filter by status, or "all" for all tasks'),
        assignee: z.string().optional().describe('Filter by agent slug'),
        parentTaskId: z.string().uuid().optional().describe('Filter subtasks of a parent task'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ status, assignee, parentTaskId }) => {
      const params = new URLSearchParams();
      if (status !== 'all') params.set('status', status);
      if (assignee) params.set('assignee', assignee);
      if (parentTaskId) params.set('parentTaskId', parentTaskId);

      const result = await apiCall(`/api/tasks?${params.toString()}`);
      const taskList = result.data ?? [];

      if (taskList.length === 0) {
        return {
          content: [{ type: 'text', text: 'No tasks found matching filters.' }],
        };
      }

      const formatted = taskList
        .map(
          (t: any) =>
            `#${t.id} [${t.status}] P${t.priority} "${t.title}" (${t.assigneeAgentId || 'unassigned'})`,
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `Found ${taskList.length} task(s):\n${formatted}`,
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------------
  // Tool: create_subtask
  // -----------------------------------------------------------------------
  server.registerTool(
    'create_subtask',
    {
      title: 'Create Subtask',
      description:
        'Create a subtask under an existing parent task. ' +
        'Useful for breaking work into smaller pieces.',
      inputSchema: {
        parentTaskId: z.string().uuid().describe('Parent task ID'),
        title: z.string().min(1).max(500).describe('Subtask title'),
        description: z.string().max(5000).optional().describe('Subtask description'),
        assignee: z.string().optional().describe('Agent slug to assign'),
        priority: z
          .enum(['1', '2', '3', '4'])
          .default('3')
          .describe('Priority: 1=critical, 2=high, 3=medium, 4=low'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ parentTaskId, title, description, assignee, priority }) => {
      const body: Record<string, unknown> = {
        title,
        description,
        priority: parseInt(priority, 10),
        parentTaskId,
        status: 'todo',
      };
      if (assignee) {
        // Resolve agent slug to UUID
        const agentRes = await apiCall(`/api/agents?slug=${encodeURIComponent(assignee)}`);
        const agents = agentRes.data ?? [];
        if (agents.length === 0) throw new Error(`Agent not found: ${assignee}`);
        body.assigneeAgentId = agents[0].id;
      }

      const result = await apiCall('/api/tasks', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const task = result.data;
      return {
        content: [
          {
            type: 'text',
            text: `Subtask created: #${task.id} "${task.title}" under parent #${parentTaskId}`,
          },
        ],
      };
    },
  );

  // -----------------------------------------------------------------------
  // Tool: assign_task
  // -----------------------------------------------------------------------
  server.registerTool(
    'assign_task',
    {
      title: 'Assign Task',
      description: 'Assign or reassign a task to a specific agent by slug.',
      inputSchema: {
        taskId: z.string().uuid().describe('Task ID to assign'),
        agentSlug: z.string().describe('Agent slug (e.g., "claude", "codex", "gemini")'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ taskId, agentSlug }) => {
      // Resolve agent slug to UUID
      const agentRes = await apiCall(`/api/agents?slug=${encodeURIComponent(agentSlug)}`);
      const agents = agentRes.data ?? [];
      if (agents.length === 0) throw new Error(`Agent not found: ${agentSlug}`);

      const result = await apiCall(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ assigneeAgentId: agents[0].id }),
      });

      const task = result.data;
      return {
        content: [
          {
            type: 'text',
            text: `Task #${task.id} "${task.title}" assigned to ${agentSlug}`,
          },
        ],
      };
    },
  );

  return server;
}

// =========================================================================
// Entry point: run as standalone process
// =========================================================================

async function main() {
  const server = createAgentMonitorServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error('[agent-monitor-mcp] Server started on stdio transport');
  console.error(`[agent-monitor-mcp] API endpoint: ${AGENT_MONITOR_API}`);
}

main().catch((err) => {
  console.error('[agent-monitor-mcp] Fatal error:', err);
  process.exit(1);
});
```

### 3.2 Build script for standalone MCP server bundle

**File**: `src/lib/mcp/build.ts`

This script bundles the MCP server into a single `dist/mcp-server.js` file that can be spawned by any agent.

```typescript
/**
 * Build the MCP server as a standalone bundle.
 *
 * Usage: npx tsx src/lib/mcp/build.ts
 *
 * Output: dist/mcp-server.js (single file, no external deps needed at runtime
 *         except Node.js built-ins)
 */

import { build } from 'esbuild';
import path from 'path';

async function buildMcpServer() {
  const result = await build({
    entryPoints: [path.resolve(__dirname, 'server.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: path.resolve(__dirname, '../../../dist/mcp-server.js'),
    // Bundle all deps into single file so agents don't need node_modules
    external: [],
    // Mark Node.js built-ins as external
    packages: 'external',
    banner: {
      js: '#!/usr/bin/env node\n',
    },
    minify: false, // Keep readable for debugging
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  console.log('MCP server built successfully:', result);
  console.log('Output: dist/mcp-server.js');
}

buildMcpServer().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
```

Add to `package.json` scripts:

```json
{
  "scripts": {
    "build:mcp": "tsx src/lib/mcp/build.ts",
    "build:all": "pnpm build && pnpm build:mcp"
  }
}
```

**Alternative build (no esbuild dependency)**: If esbuild is not desired, use `tsc` with a dedicated tsconfig:

**File**: `tsconfig.mcp.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist/mcp",
    "rootDir": "src/lib/mcp",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": false
  },
  "include": ["src/lib/mcp/server.ts"]
}
```

Then: `tsc -p tsconfig.mcp.json && cp dist/mcp/server.js dist/mcp-server.js`

Note: The tsc approach requires `@modelcontextprotocol/sdk` and `zod` to be installed wherever the MCP server runs. The esbuild approach bundles everything into one file.

### 3.3 MCP config JSON template

**File**: `src/lib/mcp/mcp-config-template.ts`

Generates MCP config files for each agent type when spawning.

```typescript
import path from 'path';

const MCP_SERVER_PATH =
  process.env.MCP_SERVER_PATH || path.resolve(__dirname, '../../../dist/mcp-server.js');

const AGENT_MONITOR_URL = process.env.AGENT_MONITOR_URL || 'http://localhost:4100';

/**
 * Generate .mcp.json content for Claude Code.
 * Written to the working directory before spawning Claude.
 */
export function generateClaudeMcpConfig(): object {
  return {
    mcpServers: {
      'agent-monitor': {
        command: 'node',
        args: [MCP_SERVER_PATH],
        env: {
          AGENT_MONITOR_URL: AGENT_MONITOR_URL,
        },
      },
    },
  };
}

/**
 * Generate Codex config.toml snippet for MCP server.
 * Appended to a temp config file before spawning Codex.
 */
export function generateCodexMcpConfig(): string {
  return `
[mcp_servers.agent-monitor]
command = "node"
args = ["${MCP_SERVER_PATH}"]

[mcp_servers.agent-monitor.env]
AGENT_MONITOR_URL = "${AGENT_MONITOR_URL}"
`.trim();
}

/**
 * Generate Gemini settings.json MCP section.
 * Written to a temp settings file before spawning Gemini.
 */
export function generateGeminiMcpConfig(): object {
  return {
    mcpServers: {
      'agent-monitor': {
        command: 'node',
        args: [MCP_SERVER_PATH],
        env: {
          AGENT_MONITOR_URL: AGENT_MONITOR_URL,
        },
      },
    },
  };
}

/**
 * Generate REST API fallback instructions for Gemini prompt injection.
 * Used when Gemini cannot reliably load MCP servers.
 */
export function generateGeminiRestFallbackInstructions(): string {
  return `
## Agent Monitor Integration (REST API)

You have access to the Agent Monitor task board via these REST endpoints:

### Create a task
\`\`\`bash
curl -s -X POST ${AGENT_MONITOR_URL}/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Task name", "status": "todo", "priority": 3}'
\`\`\`

### Update task status
\`\`\`bash
curl -s -X PATCH ${AGENT_MONITOR_URL}/api/tasks/TASK_ID \\
  -H "Content-Type: application/json" \\
  -d '{"status": "done"}'
\`\`\`

### List tasks
\`\`\`bash
curl -s "${AGENT_MONITOR_URL}/api/tasks?status=todo"
\`\`\`

### Create a subtask
\`\`\`bash
curl -s -X POST ${AGENT_MONITOR_URL}/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"title": "Subtask name", "parentTaskId": "PARENT_ID", "status": "todo", "priority": 3}'
\`\`\`

IMPORTANT: When you complete work, update the task status to "done" using the update endpoint above.
`.trim();
}
```

---

## Step 4: MCP Config Injection for Spawned Agents

### 4.1 Update execution-runner.ts to inject MCP config

Modify the existing `execution-runner.ts` (from Phase 4) to inject MCP configuration when spawning AI agents.

**File**: `src/lib/worker/execution-runner.ts` (add to existing)

Add the following before the adapter `spawn()` call in the prompt-mode execution path:

```typescript
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import {
  generateClaudeMcpConfig,
  generateCodexMcpConfig,
  generateGeminiRestFallbackInstructions,
} from '@/lib/mcp/mcp-config-template';

/**
 * Inject MCP config into the agent's working directory or temp config
 * before spawning the agent process.
 *
 * Called from execution-runner.ts when agent.mcpEnabled is true.
 */
export function injectMcpConfig(
  agentSlug: string,
  workingDir: string,
  executionId: string,
): { extraArgs: string[]; cleanup: () => void } {
  const cleanups: Array<() => void> = [];
  let extraArgs: string[] = [];

  switch (agentSlug) {
    case 'claude': {
      // Write .mcp.json to working directory
      const mcpJsonPath = path.join(workingDir, '.mcp.json');
      const existingMcp = existsSync(mcpJsonPath)
        ? JSON.parse(readFileSync(mcpJsonPath, 'utf-8'))
        : { mcpServers: {} };

      // Merge agent-monitor MCP config with existing
      const mcpConfig = generateClaudeMcpConfig();
      const merged = {
        ...existingMcp,
        mcpServers: {
          ...existingMcp.mcpServers,
          ...(mcpConfig as any).mcpServers,
        },
      };

      writeFileSync(mcpJsonPath, JSON.stringify(merged, null, 2));
      // No cleanup: .mcp.json persists (agents may reuse it)
      break;
    }

    case 'codex': {
      // Write temp config.toml with MCP section
      const tmpDir = `/tmp/agent-monitor/codex-${executionId}`;
      mkdirSync(tmpDir, { recursive: true });
      const configPath = path.join(tmpDir, 'config.toml');

      // Read existing user config if present
      const userConfigPath = path.join(process.env.HOME || '/home/ubuntu', '.codex', 'config.toml');
      let existingConfig = '';
      if (existsSync(userConfigPath)) {
        existingConfig = readFileSync(userConfigPath, 'utf-8');
      }

      // Append MCP section
      const mcpSection = generateCodexMcpConfig();
      writeFileSync(configPath, existingConfig + '\n\n' + mcpSection);

      // Point Codex to temp config
      extraArgs = ['--config', configPath];

      cleanups.push(() => {
        try {
          require('fs').rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      });
      break;
    }

    case 'gemini': {
      // Gemini: MCP config via settings.json is global, so use REST fallback
      // The REST instructions are injected into the prompt by the adapter
      // No file modifications needed here
      break;
    }
  }

  return {
    extraArgs,
    cleanup: () => cleanups.forEach((fn) => fn()),
  };
}
```

### 4.2 Update adapters to use MCP config

In each adapter's `spawn()` method (from Phase 4), add MCP config injection:

**Claude adapter** (`src/lib/worker/adapters/claude-adapter.ts`):

```typescript
// In the spawn() method, before creating the tmux session:
if (agent.mcpEnabled) {
  const { extraArgs, cleanup } = injectMcpConfig('claude', opts.cwd, opts.executionId);
  // .mcp.json is written to cwd; Claude auto-discovers it. No extra flags needed.
  this.cleanupFns.push(cleanup);
}
```

**Codex adapter** (`src/lib/worker/adapters/codex-adapter.ts`):

```typescript
// In the spawn() method, before creating the tmux session:
if (agent.mcpEnabled) {
  const { extraArgs, cleanup } = injectMcpConfig('codex', opts.cwd, opts.executionId);
  commandArgs.push(...extraArgs); // adds --config /tmp/agent-monitor/codex-{id}/config.toml
  this.cleanupFns.push(cleanup);
}
```

**Gemini adapter** (`src/lib/worker/adapters/gemini-adapter.ts`):

```typescript
// In the spawn() method, prepend REST fallback instructions to the prompt:
if (agent.mcpEnabled) {
  const restInstructions = generateGeminiRestFallbackInstructions();
  prompt = `${restInstructions}\n\n---\n\n${prompt}`;
}
```

---

## Step 5: Loop Prevention Safeguards

### 5.1 Add spawn_depth tracking to executions

The `executions` table does not have a `spawn_depth` column in the current schema. Add it via migration.

Add to schema in `src/lib/db/schema.ts`:

```typescript
// In the executions table definition, add:
spawnDepth: integer('spawn_depth').notNull().default(0),
```

Then run:

```bash
npx drizzle-kit generate
npx drizzle-kit migrate
```

### 5.2 Create loop prevention guard module

**File**: `src/lib/services/loop-prevention.ts`

```typescript
import { db } from '@/lib/db';
import { executions, tasks, workerConfig } from '@/lib/db/schema';
import { eq, and, inArray, count, gt, sql } from 'drizzle-orm';

/** Default limits (overridable via worker_config table) */
const DEFAULTS = {
  MAX_SPAWN_DEPTH: 3,
  MAX_CONCURRENT_AI_AGENTS: 3,
  MAX_TASKS_PER_AGENT_PER_MINUTE: 10,
  SPAWN_COOLDOWN_MS: 30_000,
} as const;

/** In-memory rate limiter for MCP create_task calls */
const taskCreationLog = new Map<string, number[]>(); // agentId -> timestamps

export interface LoopGuardResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check all loop prevention guards before allowing an execution to proceed.
 */
export async function checkLoopGuards(params: {
  taskId: string;
  agentId: string;
  parentExecutionId?: string;
}): Promise<LoopGuardResult> {
  const config = await getLoopConfig();

  // 1. Spawn depth limit
  const depth = await getSpawnDepth(params.parentExecutionId);
  if (depth >= config.maxSpawnDepth) {
    return {
      allowed: false,
      reason:
        `Spawn depth limit reached (${config.maxSpawnDepth}). Current depth: ${depth}. ` +
        'This prevents infinite agent-spawning loops.',
    };
  }

  // 2. Concurrent AI agent limit
  const [activeRow] = await db
    .select({ count: count() })
    .from(executions)
    .where(inArray(executions.status, ['running', 'cancelling']));

  if ((activeRow?.count ?? 0) >= config.maxConcurrentAiAgents) {
    return {
      allowed: false,
      reason:
        `Concurrent agent limit reached (${config.maxConcurrentAiAgents} active). ` +
        'Wait for existing executions to complete.',
    };
  }

  // 3. Per-task budget cap (future: track cumulative cost)
  // Placeholder: not enforced until cost tracking is implemented

  return { allowed: true };
}

/**
 * Rate limit for MCP create_task tool.
 * Max N tasks per agent per minute.
 */
export function checkTaskCreationRateLimit(
  agentId: string,
  maxPerMinute: number = DEFAULTS.MAX_TASKS_PER_AGENT_PER_MINUTE,
): LoopGuardResult {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Get or create the log for this agent
  let timestamps = taskCreationLog.get(agentId) ?? [];

  // Prune old entries
  timestamps = timestamps.filter((t) => t > oneMinuteAgo);

  if (timestamps.length >= maxPerMinute) {
    taskCreationLog.set(agentId, timestamps);
    return {
      allowed: false,
      reason:
        `Rate limit: max ${maxPerMinute} tasks per agent per minute. ` +
        `Agent ${agentId} has created ${timestamps.length} tasks in the last minute.`,
    };
  }

  // Record this creation
  timestamps.push(now);
  taskCreationLog.set(agentId, timestamps);
  return { allowed: true };
}

/**
 * Calculate spawn depth by walking the parent execution chain.
 */
async function getSpawnDepth(parentExecutionId?: string): Promise<number> {
  if (!parentExecutionId) return 0;

  let depth = 0;
  let currentId: string | null = parentExecutionId;

  // Safety cap to prevent infinite loop in case of data corruption
  while (currentId && depth < 10) {
    const [exec] = await db
      .select({ parentExecutionId: executions.parentExecutionId })
      .from(executions)
      .where(eq(executions.id, currentId));

    if (!exec) break;
    depth++;
    currentId = exec.parentExecutionId;
  }

  return depth;
}

/**
 * Read loop prevention config from worker_config table.
 * Falls back to defaults if not set.
 */
async function getLoopConfig() {
  const rows = await db
    .select()
    .from(workerConfig)
    .where(
      inArray(workerConfig.key, [
        'max_spawn_depth',
        'max_concurrent_ai_agents',
        'max_tasks_per_agent_per_minute',
      ]),
    );

  const configMap = new Map(rows.map((r) => [r.key, r.value]));

  return {
    maxSpawnDepth: Number(configMap.get('max_spawn_depth') ?? DEFAULTS.MAX_SPAWN_DEPTH),
    maxConcurrentAiAgents: Number(
      configMap.get('max_concurrent_ai_agents') ?? DEFAULTS.MAX_CONCURRENT_AI_AGENTS,
    ),
    maxTasksPerAgentPerMinute: Number(
      configMap.get('max_tasks_per_agent_per_minute') ?? DEFAULTS.MAX_TASKS_PER_AGENT_PER_MINUTE,
    ),
  };
}
```

### 5.3 Integrate loop guards into execution creation

**File**: `src/lib/services/execution-service.ts` (modify existing)

Add the following check at the top of the `createExecution` function:

```typescript
import { checkLoopGuards } from '@/lib/services/loop-prevention';

export async function createExecution(params: CreateExecutionParams) {
  // --- Loop prevention check ---
  const guard = await checkLoopGuards({
    taskId: params.taskId,
    agentId: params.agentId,
    parentExecutionId: params.parentExecutionId,
  });
  if (!guard.allowed) {
    throw new SafetyViolationError(guard.reason!);
  }

  // ... rest of existing createExecution logic ...
}
```

### 5.4 Integrate rate limiting into MCP server task creation

The rate limiting is enforced server-side in the `/api/tasks` POST handler rather than in the MCP server process itself, since the MCP server is a thin REST client.

**File**: `src/app/api/tasks/route.ts` (modify existing POST handler)

Add a rate limit check based on the `createdBy` or agent identification header:

```typescript
import { checkTaskCreationRateLimit } from '@/lib/services/loop-prevention';

// Inside the POST handler, before creating the task:
const agentId = body.createdBy || 'unknown';
if (agentId.startsWith('mcp-')) {
  const rateCheck = checkTaskCreationRateLimit(agentId);
  if (!rateCheck.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: rateCheck.reason } },
      { status: 429 },
    );
  }
}
```

When spawning agents, set `AGENT_MONITOR_AGENT_ID` env var in the MCP server's environment. The MCP server passes this as `createdBy: "mcp-{agentId}"` in the API request body.

---

## Step 6: Complete Schema Form Fields

### 6.1 Number field

**File**: `src/components/forms/schema-field-number.tsx`

```typescript
'use client';

import { useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface SchemaFieldNumberProps {
  name: string;
  label: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  required?: boolean;
}

export function SchemaFieldNumber({
  name,
  label,
  description,
  minimum,
  maximum,
  required,
}: SchemaFieldNumberProps) {
  const { register, formState: { errors } } = useFormContext();
  const error = errors[name];

  return (
    <div className="space-y-1">
      <Label htmlFor={name}>
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      <Input
        id={name}
        type="number"
        min={minimum}
        max={maximum}
        step="any"
        {...register(name, { valueAsNumber: true })}
      />
      {error && (
        <p className="text-xs text-destructive">{error.message as string}</p>
      )}
    </div>
  );
}
```

### 6.2 Enum (select) field

**File**: `src/components/forms/schema-field-enum.tsx`

```typescript
'use client';

import { useFormContext } from 'react-hook-form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

interface SchemaFieldEnumProps {
  name: string;
  label: string;
  description?: string;
  options: string[];
  required?: boolean;
}

export function SchemaFieldEnum({
  name,
  label,
  description,
  options,
  required,
}: SchemaFieldEnumProps) {
  const { setValue, watch, formState: { errors } } = useFormContext();
  const value = watch(name);
  const error = errors[name];

  return (
    <div className="space-y-1">
      <Label>
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      <Select value={value} onValueChange={(v) => setValue(name, v)}>
        <SelectTrigger>
          <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <p className="text-xs text-destructive">{error.message as string}</p>
      )}
    </div>
  );
}
```

### 6.3 Array field

**File**: `src/components/forms/schema-field-array.tsx`

```typescript
'use client';

import { useFormContext, useFieldArray } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, X } from 'lucide-react';

interface SchemaFieldArrayProps {
  name: string;
  label: string;
  description?: string;
  itemType: 'string' | 'number';
  required?: boolean;
}

export function SchemaFieldArray({
  name,
  label,
  description,
  itemType,
  required,
}: SchemaFieldArrayProps) {
  const { control, register } = useFormContext();
  const { fields, append, remove } = useFieldArray({ control, name });

  return (
    <div className="space-y-2">
      <Label>
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}

      <div className="space-y-1">
        {fields.map((field, index) => (
          <div key={field.id} className="flex items-center gap-2">
            <Input
              type={itemType === 'number' ? 'number' : 'text'}
              {...register(`${name}.${index}.value`, {
                valueAsNumber: itemType === 'number',
              })}
              className="flex-1"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(index)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => append({ value: '' })}
      >
        <Plus className="h-3 w-3 mr-1" />
        Add item
      </Button>
    </div>
  );
}
```

### 6.4 Object field (nested)

**File**: `src/components/forms/schema-field-object.tsx`

```typescript
'use client';

import { Label } from '@/components/ui/label';
import { SchemaField } from './schema-field';

interface SchemaFieldObjectProps {
  name: string;
  label: string;
  description?: string;
  properties: Record<string, any>;
  requiredFields?: string[];
}

export function SchemaFieldObject({
  name,
  label,
  description,
  properties,
  requiredFields = [],
}: SchemaFieldObjectProps) {
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="text-sm font-medium px-1">{label}</legend>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}

      {Object.entries(properties).map(([key, schema]) => (
        <SchemaField
          key={key}
          name={`${name}.${key}`}
          schema={schema as any}
          required={requiredFields.includes(key)}
        />
      ))}
    </fieldset>
  );
}
```

### 6.5 Update the SchemaField router to support all types

**File**: `src/components/forms/schema-field.tsx` (modify existing)

```typescript
'use client';

import { SchemaFieldString } from './schema-field-string';
import { SchemaFieldBoolean } from './schema-field-boolean';
import { SchemaFieldNumber } from './schema-field-number';
import { SchemaFieldEnum } from './schema-field-enum';
import { SchemaFieldArray } from './schema-field-array';
import { SchemaFieldObject } from './schema-field-object';

interface SchemaFieldProps {
  name: string;
  schema: {
    type?: string;
    title?: string;
    description?: string;
    enum?: string[];
    minimum?: number;
    maximum?: number;
    items?: { type?: string };
    properties?: Record<string, any>;
    required?: string[];
  };
  required?: boolean;
}

export function SchemaField({ name, schema, required }: SchemaFieldProps) {
  const label = schema.title || name;

  // Enum (select dropdown)
  if (schema.enum && schema.enum.length > 0) {
    return (
      <SchemaFieldEnum
        name={name}
        label={label}
        description={schema.description}
        options={schema.enum}
        required={required}
      />
    );
  }

  // Route by type
  switch (schema.type) {
    case 'string':
      return (
        <SchemaFieldString
          name={name}
          label={label}
          description={schema.description}
          required={required}
        />
      );

    case 'boolean':
      return (
        <SchemaFieldBoolean
          name={name}
          label={label}
          description={schema.description}
        />
      );

    case 'number':
    case 'integer':
      return (
        <SchemaFieldNumber
          name={name}
          label={label}
          description={schema.description}
          minimum={schema.minimum}
          maximum={schema.maximum}
          required={required}
        />
      );

    case 'array':
      return (
        <SchemaFieldArray
          name={name}
          label={label}
          description={schema.description}
          itemType={(schema.items?.type as 'string' | 'number') ?? 'string'}
          required={required}
        />
      );

    case 'object':
      return (
        <SchemaFieldObject
          name={name}
          label={label}
          description={schema.description}
          properties={schema.properties ?? {}}
          requiredFields={schema.required}
        />
      );

    default:
      // Fallback to string
      return (
        <SchemaFieldString
          name={name}
          label={label}
          description={schema.description}
          required={required}
        />
      );
  }
}
```

### 6.6 JSON Schema to Zod runtime conversion for form validation

**File**: `src/lib/schema-to-zod.ts`

Build the Zod schema programmatically from JSON Schema properties rather than using string evaluation. This is safe and does not require `json-schema-to-zod` as a dependency.

```typescript
import { z, type ZodType } from 'zod';

/**
 * Convert a JSON Schema object to a Zod schema at runtime.
 * Used by schema-form.tsx to validate form data before submission.
 *
 * Supports: string, number, integer, boolean, array (of primitives),
 * object (nested), enum. Does not cover full JSON Schema spec --
 * only the subset used by agent_capabilities.args_schema.
 *
 * @param jsonSchema - The JSON Schema from agent_capabilities.args_schema
 * @returns A Zod schema that validates according to the JSON Schema
 */
export function convertJsonSchemaToZod(jsonSchema: Record<string, unknown>): ZodType {
  if (!jsonSchema || Object.keys(jsonSchema).length === 0) {
    return z.object({}).passthrough();
  }

  return convertNode(jsonSchema, jsonSchema.required as string[] | undefined);
}

function convertNode(schema: Record<string, unknown>, parentRequired?: string[]): ZodType {
  // Enum
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum as [string, ...string[]];
    return z.enum(values);
  }

  switch (schema.type) {
    case 'string': {
      let s = z.string();
      if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
      if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
      if (typeof schema.pattern === 'string') s = s.regex(new RegExp(schema.pattern));
      return s;
    }

    case 'number':
    case 'integer': {
      let n = z.number();
      if (schema.type === 'integer') n = n.int();
      if (typeof schema.minimum === 'number') n = n.min(schema.minimum);
      if (typeof schema.maximum === 'number') n = n.max(schema.maximum);
      return n;
    }

    case 'boolean':
      return z.boolean();

    case 'array': {
      const items = (schema.items ?? { type: 'string' }) as Record<string, unknown>;
      const itemSchema = convertNode(items);
      let arr = z.array(itemSchema);
      if (typeof schema.minItems === 'number') arr = arr.min(schema.minItems);
      if (typeof schema.maxItems === 'number') arr = arr.max(schema.maxItems);
      return arr;
    }

    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required ?? []) as string[];

      const shape: Record<string, ZodType> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        let fieldZod = convertNode(propSchema);
        if (!required.includes(key)) {
          fieldZod = fieldZod.optional();
        }
        shape[key] = fieldZod;
      }

      return z.object(shape);
    }

    default:
      // Unknown type: accept any value
      return z.any();
  }
}
```

### 6.7 Update schema-form.tsx to use zodResolver

**File**: `src/components/forms/schema-form.tsx` (modify existing)

```typescript
'use client';

import { FormProvider, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { SchemaField } from './schema-field';
import { convertJsonSchemaToZod } from '@/lib/schema-to-zod';

interface SchemaFormProps {
  schema: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  onSubmit: (data: Record<string, unknown>) => void;
  isSubmitting?: boolean;
  submitLabel?: string;
}

export function SchemaForm({
  schema,
  onSubmit,
  isSubmitting,
  submitLabel = 'Submit',
}: SchemaFormProps) {
  const zodSchema = convertJsonSchemaToZod(schema);
  const methods = useForm({
    resolver: zodResolver(zodSchema),
  });

  const properties = schema.properties ?? {};
  const requiredFields = schema.required ?? [];

  return (
    <FormProvider {...methods}>
      <form onSubmit={methods.handleSubmit(onSubmit)} className="space-y-4">
        {Object.entries(properties).map(([key, fieldSchema]) => (
          <SchemaField
            key={key}
            name={key}
            schema={fieldSchema as any}
            required={requiredFields.includes(key)}
          />
        ))}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Submitting...' : submitLabel}
        </Button>
      </form>
    </FormProvider>
  );
}
```

---

## Step 7: Virtual Scrolling for Executions Table

### 7.1 Add virtual scrolling to execution-table.tsx

**File**: `src/components/executions/execution-table.tsx` (modify existing)

```typescript
'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ExecutionRow } from './execution-row';
import type { Execution } from '@/lib/types';

interface ExecutionTableProps {
  executions: Execution[];
}

const ROW_HEIGHT = 56; // px per row

export function ExecutionTable({ executions }: ExecutionTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: executions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20, // Render 20 extra rows above/below viewport
  });

  return (
    <div className="rounded-md border">
      {/* Table header */}
      <div className="flex items-center border-b bg-muted/50 px-4 py-2 text-sm font-medium text-muted-foreground">
        <div className="w-[200px]">Task</div>
        <div className="w-[120px]">Agent</div>
        <div className="w-[100px]">Status</div>
        <div className="w-[100px]">Duration</div>
        <div className="flex-1">Started</div>
        <div className="w-[80px]">Actions</div>
      </div>

      {/* Virtual scroll container */}
      <div
        ref={parentRef}
        className="overflow-auto"
        style={{ height: `min(${executions.length * ROW_HEIGHT}px, 70vh)` }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const execution = executions[virtualItem.index];
            return (
              <div
                key={execution.id}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <ExecutionRow execution={execution} />
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer with count */}
      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        {executions.length} execution{executions.length !== 1 ? 's' : ''}
      </div>
    </div>
  );
}
```

---

## Step 8: Log Rotation

### 8.1 Create log rotation function

**File**: `src/lib/services/log-rotation.ts`

```typescript
import { readdir, unlink, stat } from 'fs/promises';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || '/data/agent-monitor/logs';
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Delete log files older than the retention period.
 * Intended to run as a pg-boss scheduled job (cron).
 */
export async function rotateOldLogs(
  retentionDays: number = DEFAULT_RETENTION_DAYS,
): Promise<{ deleted: number; errors: number }> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  let errors = 0;

  try {
    const files = await readdir(LOG_DIR);

    for (const file of files) {
      if (!file.endsWith('.log')) continue;

      const filePath = path.join(LOG_DIR, file);
      try {
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs < cutoff) {
          await unlink(filePath);
          deleted++;
        }
      } catch (err) {
        errors++;
        console.error(`[log-rotation] Failed to process ${filePath}:`, err);
      }
    }
  } catch (err) {
    console.error('[log-rotation] Failed to read log directory:', err);
  }

  console.log(`[log-rotation] Completed: ${deleted} deleted, ${errors} errors`);
  return { deleted, errors };
}
```

### 8.2 Schedule log rotation in worker

**File**: `src/worker/index.ts` (add to existing)

Add after pg-boss `boss.start()`:

```typescript
import { rotateOldLogs } from '@/lib/services/log-rotation';

// Schedule daily log rotation via pg-boss cron
await boss.schedule(
  'log-rotation',
  '0 3 * * *',
  {},
  {
    // Run at 3 AM daily
    tz: 'UTC',
  },
);

await boss.work('log-rotation', async () => {
  await rotateOldLogs();
});
```

---

## Step 9: Worker Status Enhancement

### 9.1 Update worker heartbeat to include extra metadata

**File**: `src/lib/worker/heartbeat.ts` (modify existing)

Add the following to the heartbeat update function:

```typescript
import { db } from '@/lib/db';
import { workerHeartbeats } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function updateWorkerHeartbeat(
  workerId: string,
  currentExecutions: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({
      workerId,
      lastSeenAt: new Date(),
      currentExecutions,
      metadata: metadata ?? {},
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        lastSeenAt: new Date(),
        currentExecutions,
        metadata: metadata ?? {},
      },
    });
}
```

The `metadata` field can include uptime, last claim time, and memory usage:

```typescript
// In worker/index.ts, during the heartbeat interval:
const startTime = Date.now();

setInterval(async () => {
  await updateWorkerHeartbeat(WORKER_ID, runningJobs.size, {
    uptimeMs: Date.now() - startTime,
    lastClaimAt: lastClaimTimestamp?.toISOString(),
    memoryUsageMb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
  });
}, 30_000);
```

---

## Step 10: Polish Pass

### 10.1 Loading skeletons

Add skeleton components for each data-fetching component.

**File**: `src/components/ui/skeleton-card.tsx`

```typescript
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function SkeletonCard() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-4" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-16 mb-1" />
        <Skeleton className="h-3 w-32" />
      </CardContent>
    </Card>
  );
}
```

### 10.2 Empty states

**File**: `src/components/ui/empty-state.tsx`

```typescript
import { InboxIcon } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <InboxIcon className="h-12 w-12 text-muted-foreground/50 mb-4" />
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

### 10.3 Error boundary

**File**: `src/components/ui/error-boundary.tsx`

```typescript
'use client';

import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center py-8 text-center border rounded-md bg-destructive/5">
          <AlertTriangle className="h-8 w-8 text-destructive mb-2" />
          <p className="text-sm font-medium">Something went wrong</p>
          <p className="text-xs text-muted-foreground mt-1">
            {this.state.error?.message ?? 'An unexpected error occurred'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

### 10.4 Command palette

**File**: `src/components/layout/command-palette.tsx`

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { Search, ListTodo, Bot, Play, LayoutDashboard } from 'lucide-react';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tasks, setTasks] = useState<Array<{ id: string; title: string; status: string }>>([]);
  const router = useRouter();

  // Open with "/" or Cmd+K
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        setOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Search tasks when query changes
  useEffect(() => {
    if (query.length < 2) {
      setTasks([]);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/tasks?search=${encodeURIComponent(query)}&limit=10`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => setTasks(data.data ?? []))
      .catch(() => {});

    return () => controller.abort();
  }, [query]);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Search tasks, navigate..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Navigation */}
        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => { router.push('/'); setOpen(false); }}>
            <LayoutDashboard className="mr-2 h-4 w-4" />
            Dashboard
          </CommandItem>
          <CommandItem onSelect={() => { router.push('/tasks'); setOpen(false); }}>
            <ListTodo className="mr-2 h-4 w-4" />
            Tasks
          </CommandItem>
          <CommandItem onSelect={() => { router.push('/agents'); setOpen(false); }}>
            <Bot className="mr-2 h-4 w-4" />
            Agents
          </CommandItem>
          <CommandItem onSelect={() => { router.push('/executions'); setOpen(false); }}>
            <Play className="mr-2 h-4 w-4" />
            Executions
          </CommandItem>
        </CommandGroup>

        {/* Task search results */}
        {tasks.length > 0 && (
          <CommandGroup heading="Tasks">
            {tasks.map((task) => (
              <CommandItem
                key={task.id}
                onSelect={() => {
                  router.push(`/tasks?selected=${task.id}`);
                  setOpen(false);
                }}
              >
                <Search className="mr-2 h-4 w-4" />
                <span className="truncate">{task.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  [{task.status}]
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
```

Add `<CommandPalette />` to `src/components/layout/app-shell.tsx`.

### 10.5 Sidebar enhancements

**File**: `src/components/layout/sidebar.tsx` (modify existing)

Add live badge counts to sidebar nav items. These are fetched client-side with polling:

```typescript
'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';

function useLiveCounts() {
  const [counts, setCounts] = useState({ runningExecutions: 0, queuedTasks: 0 });

  useEffect(() => {
    const fetchCounts = async () => {
      try {
        const res = await fetch('/api/dashboard');
        if (res.ok) {
          const { data } = await res.json();
          setCounts({
            runningExecutions: data.activeExecutions ?? 0,
            queuedTasks: data.taskCountsByStatus?.todo ?? 0,
          });
        }
      } catch {
        /* ignore */
      }
    };

    fetchCounts();
    const interval = setInterval(fetchCounts, 10_000);
    return () => clearInterval(interval);
  }, []);

  return counts;
}
```

Display the counts as `<Badge>` next to "Executions" and "Tasks" nav links.

### 10.6 Responsive board

Add to `task-board.tsx` container:

```typescript
// Board container with responsive horizontal scroll
<div className="flex gap-4 overflow-x-auto pb-4 min-h-[calc(100vh-8rem)]">
  {/* min-w-[280px] on each column ensures readability on narrow viewports */}
  {STATUSES.map((status) => (
    <TaskColumn
      key={status}
      // ...props
      className="min-w-[280px] w-[320px] shrink-0"
    />
  ))}
</div>
```

---

## Testing Checklist

### Unit Tests

- [ ] **`schema-to-zod.ts` -- convertJsonSchemaToZod**: Verify conversion for string, number, boolean, enum, array, and object fields. Test `minLength`, `minimum`, `pattern` constraints.
- [ ] **MCP server `create_task` tool**: Mock fetch, verify correct REST endpoint called with correct body
- [ ] **MCP server `list_tasks` tool**: Mock fetch, verify query params passed correctly, output formatted as expected
- [ ] **MCP server `update_task` tool**: Mock fetch, verify PATCH method and correct body
- [ ] **Loop prevention -- depth limit**: `checkLoopGuards` returns `{ allowed: false }` when `spawn_depth >= 3`
- [ ] **Loop prevention -- concurrency limit**: `checkLoopGuards` returns `{ allowed: false }` when 3 executions are running
- [ ] **Loop prevention -- rate limit**: `checkTaskCreationRateLimit` returns `{ allowed: false }` after 10 calls in 1 minute

### Integration Tests

- [ ] **Dashboard stats query**: Create known tasks/executions, verify `getDashboardStats()` returns correct counts
- [ ] **MCP server end-to-end**: Spawn MCP server process, send `create_task` tool call via stdio, verify task created in DB
- [ ] **MCP server with list_tasks**: Create tasks via API, call `list_tasks` via MCP, verify formatted output matches
- [ ] **Log rotation**: Create log files with old timestamps, run `rotateOldLogs()`, verify files deleted

### Manual Tests

- [ ] **Virtual scrolling**: Load 1000+ executions, verify smooth scrolling, no performance degradation
- [ ] **Command palette**: Press `/`, type a task name, verify search results appear, click to navigate
- [ ] **Schema form**: Create a capability with complex `args_schema` (object with nested fields, arrays, enums), verify form renders correctly and validates

---

## Verification

After completing all steps:

1. **Dashboard**: Navigate to `/` -- four stat cards show correct counts, active executions list shows running jobs, recent activity feed shows latest events, agent health grid shows all agents
2. **MCP server build**: Run `pnpm build:mcp` -- `dist/mcp-server.js` is created, runs standalone with `node dist/mcp-server.js`
3. **MCP server test**: Spawn MCP server, use MCP Inspector or manual stdio to call `create_task` -- task appears on Kanban board
4. **Claude MCP integration**: Place `.mcp.json` in project root with agent-monitor config, start Claude Code, verify `mcp__agent-monitor__create_task` tool is available
5. **Gemini REST fallback**: Spawn Gemini with REST instructions in prompt, verify Gemini can call `curl` to create/update tasks
6. **Loop prevention**: Attempt to create execution with `spawn_depth = 3` -- rejected with clear error message
7. **Loop prevention rate limit**: Rapidly call `create_task` 11 times via MCP -- 11th call rejected with rate limit message
8. **Schema form**: Open execution trigger dialog for a capability with complex `args_schema` -- all field types render (string, number, boolean, enum, array, object)
9. **Virtual scrolling**: Navigate to executions page with 500+ rows -- table scrolls smoothly without layout thrashing
10. **Command palette**: Press `/` anywhere on the app -- dialog opens, search for task by title, click result to navigate
11. **Empty states**: Navigate to a page with no data -- helpful empty state message shown instead of blank page
12. **Error boundary**: Introduce a render error in a component -- error boundary catches it, shows retry button
13. **Log rotation**: Verify pg-boss schedules the `log-rotation` job, check that old log files are cleaned up
14. **Worker status**: Check dashboard agent health -- shows worker online status, current execution count, uptime
